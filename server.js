import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));

const BRIDGE_BASE = "https://api.bridgeapi.io/v3";
const { BRIDGE_CLIENT_ID, BRIDGE_CLIENT_SECRET, REDIRECT_URI = "http://localhost:3000/auth/bridge/callback", ANTHROPIC_API_KEY } = process.env;
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bridgeHeaders = (t=null) => ({"Bridge-Version":"2021-06-01","Client-Id":BRIDGE_CLIENT_ID,"Client-Secret":BRIDGE_CLIENT_SECRET,"Content-Type":"application/json",...(t&&{Authorization:`Bearer ${t}`})});

// ── Bridge OAuth ───────────────────────────────────
app.post("/auth/bridge/create-user", async (req,res) => {
  try {
    const { data } = await axios.post(`${BRIDGE_BASE}/users`,{external_user_id:req.body.userId||uuidv4()},{headers:bridgeHeaders()});
    res.json({bridgeUserId:data.uuid});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/auth/bridge/connect", async (req,res) => {
  const {bridgeUserId}=req.query;
  if(!bridgeUserId) return res.status(400).json({error:"bridgeUserId requis"});
  const url=`https://connect.bridgeapi.io/v2/connect?client_id=${BRIDGE_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&user_uuid=${bridgeUserId}&country=FR`;
  res.json({connectUrl:url});
});

app.get("/auth/bridge/callback", async (req,res) => {
  const {code,error}=req.query;
  if(error) return res.redirect(`http://localhost:5173?error=${error}`);
  try {
    const {data}=await axios.post(`${BRIDGE_BASE}/oauth/token`,{code,grant_type:"authorization_code",redirect_uri:REDIRECT_URI},{headers:bridgeHeaders()});
    res.redirect(`http://localhost:5173/dashboard?token=${data.access_token}`);
  } catch(e){res.redirect(`http://localhost:5173?error=token_exchange_failed`);}
});

app.get("/api/accounts", async (req,res) => {
  const t=req.headers.authorization?.split(" ")[1];
  if(!t) return res.status(401).json({error:"Token manquant"});
  try{const {data}=await axios.get(`${BRIDGE_BASE}/accounts`,{headers:bridgeHeaders(t)});res.json(data.resources);}
  catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/transactions", async (req,res) => {
  const t=req.headers.authorization?.split(" ")[1];
  if(!t) return res.status(401).json({error:"Token manquant"});
  try{
    const {data}=await axios.get(`${BRIDGE_BASE}/transactions?limit=${req.query.limit||50}`,{headers:bridgeHeaders(t)});
    res.json({transactions:data.resources.map(tx=>({id:tx.id,name:tx.label||tx.clean_description||"Transaction",amount:tx.amount,date:tx.date,cat:mapCat(tx.category_id),icon:catIcon(tx.category_id)}))});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── Parse PDF ──────────────────────────────────────
app.post("/api/parse-pdf", async (req,res) => {
  const {base64}=req.body;
  if(!base64) return res.status(400).json({error:"PDF manquant"});

  const PROMPT = `Tu es un expert comptable. Analyse ce relevé bancaire (BNP, Revolut, Société Générale, LCL, ou autre banque) et extrait TOUTES les transactions du compte principal.

Réponds UNIQUEMENT avec un tableau JSON valide, sans aucun texte avant ou après.
Format (commence par [ et termine par ]) :
[{"name":"Spotify","amount":-9.99,"date":"16/04","cat":"abonnement","icon":"🎵","is_subscription":true,"merchant_domain":"spotify.com","frequency":"monthly"}]

Règles STRICTES :
- amount : NÉGATIF = argent sorti (dépense, virement sortant), POSITIF = argent entrant (crédit, virement reçu)
- Pour Revolut : "Argent sortant" = négatif, "Argent entrant" = positif
- date : format JJ/MM (extrais le jour et le mois de la date)
- name : nom court et lisible (ex: "Uber" pas "Ubr* Pending.uber.com Amsterdam", "Loyer" pour les loyers, "Apple" pas "Apple.com/bill")
- cat : abonnement | alimentation | transport | loisir | sante | shopping | logement | revenu | frais | virement | unknown
  * abonnement : Netflix, Spotify, Apple, Free, SFR, Orange, Disney+, YouTube, Claude.ai
  * alimentation : restaurants, supermarchés, fast-food, épiceries
  * transport : Uber, Heetch, SNCF, essence, péage, parking, transports
  * logement : loyer, charges
  * virement : virements entre personnes, "To Ben", "From Fatoumata" etc.
  * revenu : salaires, remboursements reçus, Moneygram entrant, PayPal entrant
  * frais : frais bancaires, remboursements de crédit
- is_subscription : true si service récurrent mensuel/annuel
- merchant_domain : domaine web du marchand si connu (uber.com, apple.com, anthropic.com...), sinon null
- frequency : "monthly" | "annual" | "unique"
- INCLURE toutes les lignes SAUF les mouvements internes de Pocket/épargne (lignes "Sur la Pocket EUR" et "Retrait depuis une Pocket")
- NE PAS inclure les lignes de solde ou de résumé
- Commence DIRECTEMENT par [ sans aucun texte avant`;

  let msg, lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      msg = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: PROMPT }
          ]
        }]
      });
      break;
    } catch(e) {
      lastErr = e;
      if (e.message?.includes("overloaded") || e.status === 529) {
        console.log(`Overloaded, retry ${attempt+1}/4 dans ${(attempt+1)*3}s...`);
        await new Promise(r => setTimeout(r, (attempt+1) * 3000));
      } else {
        console.error("ERREUR PDF:", e.message, e.status);
        throw e;
      }
    }
  }

  if (!msg) {
    console.error("Toutes les tentatives ont échoué:", lastErr?.message);
    return res.status(500).json({error: lastErr?.message || "Erreur inconnue"});
  }

  try {
    const txt = msg.content?.[0]?.text || "[]";
    console.log("RÉPONSE IA (parse-pdf):", txt.substring(0, 400));
    const match = txt.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("Aucune transaction trouvée dans ce relevé");
    const transactions = JSON.parse(match[0]);
    if (!Array.isArray(transactions) || transactions.length === 0) throw new Error("Aucune transaction trouvée dans ce relevé");
    res.json({ transactions });
  } catch(e) {
    console.error("ERREUR PARSING:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Parse contrat de prêt ──────────────────────────
app.post("/api/parse-loan", async (req,res) => {
  const {base64}=req.body;
  if(!base64) return res.status(400).json({error:"PDF manquant"});

  const PROMPT = `Tu es un expert en crédit bancaire. Analyse ce contrat de prêt/crédit et extrais les informations clés.
Réponds UNIQUEMENT en JSON valide, rien d'autre :
{
  "name": "type de crédit (ex: Crédit Auto, Prêt Immobilier, Crédit Conso, Sofinco, Oney, Cofidis...)",
  "capital": montant_emprunté_en_euros (nombre),
  "rate": taux_annuel_effectif_global_TAEG_en_pourcentage (nombre, ex: 3.5),
  "duration": durée_totale_en_mois (nombre entier),
  "monthly": mensualité_en_euros (nombre),
  "start": "YYYY-MM-DD date première échéance ou date d'effet",
  "lender": "nom de l'organisme prêteur",
  "type": "immo|auto|conso|revolving|autre"
}
Cherche dans le document : montant financé/emprunté, TAEG ou taux effectif global, durée en mois, mensualité, date de première échéance.
Si une valeur est introuvable, mets null.`;

  let msg, lastErr;
  for(let attempt=0;attempt<3;attempt++){
    try{
      msg=await anthropic.messages.create({
        model:"claude-haiku-4-5",max_tokens:1000,
        messages:[{role:"user",content:[
          {type:"document",source:{type:"base64",media_type:"application/pdf",data:base64}},
          {type:"text",text:PROMPT}
        ]}]
      });
      break;
    }catch(e){
      lastErr=e;
      if(e.message?.includes("overloaded")||e.status===529){
        await new Promise(r=>setTimeout(r,(attempt+1)*3000));
      } else throw e;
    }
  }
  if(!msg) return res.status(500).json({error:lastErr?.message});
  try{
    const txt=msg.content?.[0]?.text||"{}";
    console.log("LOAN PARSE:", txt.substring(0,300));
    const match=txt.match(/\{[\s\S]*\}/);
    res.json(match?JSON.parse(match[0]):{});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── Catégorisation IA ──────────────────────────────
app.post("/api/categorize", async (req,res) => {
  const {text}=req.body;
  if(!text) return res.status(400).json({error:"Texte manquant"});
  try{
    const msg=await anthropic.messages.create({
      model:"claude-haiku-4-5",
      max_tokens:500,
      messages:[{role:"user",content:text}]
    });
    res.json({text:msg.content?.[0]?.text||"{}"});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── Analyse budget IA ──────────────────────────────
app.post("/api/analyze", async (req,res) => {
  const {transactions,budgets}=req.body;
  if(!transactions?.length) return res.status(400).json({error:"Transactions manquantes"});
  try{
    const depTotal=transactions.filter(t=>t.amount<0).reduce((s,t)=>s+Math.abs(t.amount),0);
    const byCat={};
    transactions.filter(t=>t.amount<0).forEach(t=>{byCat[t.cat]=(byCat[t.cat]||0)+Math.abs(t.amount);});
    const budgetInfo=budgets?Object.entries(budgets).map(([cat,b])=>`${cat}: dépensé ${(byCat[cat]||0).toFixed(2)}€ / budget ${b}€`).join(", "):"";

    const prompt=`Tu es un conseiller financier expert. Voici les données :
Transactions: ${transactions.slice(0,20).map(t=>`${t.name}:${t.amount}€`).join(", ")}
Total dépenses: ${depTotal.toFixed(2)}€
Par catégorie: ${Object.entries(byCat).map(([c,v])=>`${c}:${v.toFixed(2)}€`).join(", ")}
${budgetInfo?`Budgets: ${budgetInfo}`:""}

Réponds UNIQUEMENT en JSON valide :
{"insights":["phrase1","phrase2","phrase3"],"alerts":["alerte si dépassement"],"savings_tip":"conseil concret","score":75}
Score de santé financière de 0 à 100.`;

    const msg=await anthropic.messages.create({
      model:"claude-haiku-4-5",
      max_tokens:800,
      messages:[{role:"user",content:prompt}]
    });
    const txt=msg.content?.[0]?.text||"{}";
    console.log("RÉPONSE IA (analyze):", txt.substring(0, 300));
    const match=txt.match(/\{[\s\S]*\}/);
    res.json(match?JSON.parse(match[0]):{insights:[],alerts:[],savings_tip:"",score:50});
  }catch(e){res.status(500).json({error:e.message});}
});

function mapCat(id){const m={1:"alimentation",2:"alimentation",4:"transport",5:"transport",6:"logement",7:"logement",8:"sante",9:"loisir",10:"loisir",11:"shopping",12:"shopping",13:"abonnement",14:"abonnement",60:"revenu",61:"revenu"};return m[id]||"unknown";}
function catIcon(id){const i={1:"🍽️",2:"🛒",4:"🚗",5:"🚇",6:"🏠",7:"⚡",8:"💊",9:"🎬",10:"🎵",11:"👕",12:"📦",13:"📱",14:"🌐",60:"💼",61:"💰"};return i[id]||"💳";}

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`✅ Serveur Bridge backend lancé sur http://localhost:${PORT}`));
