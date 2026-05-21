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
  const {base64} = req.body;
  if (!base64) return res.status(400).json({error:"PDF manquant"});

  const PROMPT = `Extrais TOUTES les transactions de ce relevé bancaire en JSON compact.
RÈGLES:
- Réponds UNIQUEMENT avec [ ... ] JSON valide, rien d'autre
- amount: négatif=sorti, positif=entrant (Revolut: "Argent sortant"=négatif)
- IGNORER: "Sur la Pocket EUR", "Retrait depuis une Pocket", lignes de solde
- date: JJ/MM, name: court, cat: abonnement|alimentation|transport|loisir|sante|shopping|logement|revenu|virement|frais|unknown
- JSON COMPACT sans espaces inutiles
- Format: [{"name":"X","amount":-9.99,"date":"01/04","cat":"transport","icon":"🚗","is_subscription":false,"merchant_domain":null,"frequency":"unique"}]
- Commence DIRECTEMENT par [`;

  async function parseChunk(b64, attempt=0) {
    try {
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 16000,
        messages: [{
          role: "user",
          content: [
            {type:"document", source:{type:"base64", media_type:"application/pdf", data:b64}},
            {type:"text", text:PROMPT}
          ]
        }]
      });

      const txt = msg.content?.[0]?.text || "[]";
      console.log("RÉPONSE IA:", txt.substring(0, 300));

      let clean = txt.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
      let match = clean.match(/\[[\s\S]*\]/);
      if (!match) return [];

      let jsonStr = match[0];
      try {
        return JSON.parse(jsonStr);
      } catch(e) {
        // Réparer JSON tronqué
        const lastClose = jsonStr.lastIndexOf("}");
        if (lastClose > 0) {
          jsonStr = jsonStr.substring(0, lastClose + 1) + "]";
          try { return JSON.parse(jsonStr); } catch(e2) { return []; }
        }
        return [];
      }
    } catch(e) {
      if ((e.message?.includes("overloaded") || e.status===529) && attempt < 3) {
        await new Promise(r=>setTimeout(r,(attempt+1)*4000));
        return parseChunk(b64, attempt+1);
      }
      console.error("Erreur chunk:", e.message);
      return [];
    }
  }

  try {
    // Décoder le PDF pour estimer la taille
    const pdfBuffer = Buffer.from(base64, 'base64');
    const pdfSizeMB = pdfBuffer.length / (1024*1024);
    console.log(`PDF size: ${pdfSizeMB.toFixed(2)} MB`);

    let allTransactions = [];

    if (pdfSizeMB <= 3) {
      // Petit PDF — un seul appel
      allTransactions = await parseChunk(base64);
    } else {
      // Gros PDF — découper en 3 passes avec prompt différent
      console.log("Gros PDF détecté — parsing en plusieurs passes...");

      const passes = [
        `${PROMPT}

IMPORTANT: Extrait UNIQUEMENT les transactions des 4 PREMIERS MOIS du document.`,
        `${PROMPT}

IMPORTANT: Extrait UNIQUEMENT les transactions des mois 5 à 8 du document.`,
        `${PROMPT}

IMPORTANT: Extrait UNIQUEMENT les transactions des 4 DERNIERS MOIS du document.`,
      ];

      for (let i = 0; i < passes.length; i++) {
        const msg = await anthropic.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 16000,
          messages: [{
            role: "user",
            content: [
              {type:"document", source:{type:"base64", media_type:"application/pdf", data:base64}},
              {type:"text", text: passes[i]}
            ]
          }]
        });

        const txt = msg.content?.[0]?.text || "[]";
        console.log(`Passe ${i+1} réponse:`, txt.substring(0, 200));
        let clean = txt.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
        let match = clean.match(/\[[\s\S]*\]/);
        if (match) {
          let jsonStr = match[0];
          try {
            const txs = JSON.parse(jsonStr);
            allTransactions = [...allTransactions, ...txs];
            console.log(`Passe ${i+1}: ${txs.length} transactions`);
          } catch(e) {
            const lastClose = jsonStr.lastIndexOf("}");
            if (lastClose > 0) {
              jsonStr = jsonStr.substring(0, lastClose+1)+"]";
              try {
                const txs = JSON.parse(jsonStr);
                allTransactions = [...allTransactions, ...txs];
              } catch(e2) {}
            }
          }
        }
        // Pause entre les passes
        if (i < passes.length-1) await new Promise(r=>setTimeout(r,1500));
      }

      // Dédoublonner par nom+date+montant
      const seen = new Set();
      allTransactions = allTransactions.filter(tx => {
        const key = `${tx.name}|${tx.date}|${tx.amount}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
    }

    if (allTransactions.length === 0) {
      return res.status(500).json({error:"Aucune transaction trouvée"});
    }

    console.log(`✅ Total: ${allTransactions.length} transactions`);
    res.json({transactions: allTransactions});

  } catch(e) {
    console.error("ERREUR parse-pdf:", e.message);
    res.status(500).json({error: e.message});
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
