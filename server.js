import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" })); // Augmenté pour les PDF de 7 pages

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post("/api/parse-pdf", async (req, res) => {
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: "PDF manquant" });

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { 
            type: "text", 
            text: "Extrais toutes les transactions de ce relevé BNP. Réponds UNIQUEMENT avec un tableau JSON. Format: [{\"name\":\"LIBELLE\",\"amount\":-10.50,\"date\":\"JJ/MM\",\"cat\":\"alimentation\",\"icon\":\"🛒\"}]. Ne mets aucun texte avant ou après." 
          }
        ]
      }]
    });

    let rawText = response.content[0].text;
    
    // SÉCURITÉ : On isole uniquement ce qui est entre les crochets [ ]
    const start = rawText.indexOf('[');
    const end = rawText.lastIndexOf(']') + 1;
    
    if (start === -1) throw new Error("Format JSON introuvable dans la réponse");
    
    const transactions = JSON.parse(rawText.substring(start, end));
    res.json({ transactions });
  } catch (err) {
    console.error("Erreur PDF:", err);
    res.status(500).json({ error: "Échec de l'analyse des données" });
  }
});

// Garde tes autres routes (categorize, accounts, etc.) ici...
app.post("/api/categorize", async (req, res) => {
  const { text } = req.body;
  try {
    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 400,
      messages: [{ role: "user", content: `Transaction: "${text}". Réponds UNIQUEMENT en JSON: {"name":"nom","amount":-10,"cat":"cat","icon":"emoji"}` }]
    });
    res.json({ text: message.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur sur port ${PORT}`));