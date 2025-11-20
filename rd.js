const axios = require("axios");

const RD_API = "https://api.real-debrid.com/rest/1.0";

async function getStreamLink(apiKey, magnetLink) {
    try {
        const headers = { Authorization: `Bearer ${apiKey}` };

        // 1. Aggiungi Magnet
        const addResp = await axios.post(`${RD_API}/torrents/addMagnet`, `magnet=${encodeURIComponent(magnetLink)}`, { headers });
        const torrentId = addResp.data.id;

        // 2. Seleziona tutti i file
        await axios.post(`${RD_API}/torrents/selectFiles/${torrentId}`, "files=all", { headers });

        // 3. Ottieni Info (per trovare il link hoster originale)
        const infoResp = await axios.get(`${RD_API}/torrents/info/${torrentId}`, { headers });
        
        // Se non ci sono link (file non ancora scaricato sui server RD), usciamo
        if (!infoResp.data.links || infoResp.data.links.length === 0) {
            throw new Error("File non ancora presente nella cache di Real-Debrid.");
        }

        // Prendiamo il primo link della lista
        const originalLink = infoResp.data.links[0];

        // 4. Sblocca il link (Unrestrict)
        const unrestrictResp = await axios.post(`${RD_API}/unrestrict/link`, `link=${originalLink}`, { headers });

        return {
            url: unrestrictResp.data.download,
            filename: unrestrictResp.data.filename,
            size: unrestrictResp.data.filesize
        };

    } catch (error) {
        console.error("RD Error:", error.response?.data || error.message);
        return null; // Ritorna null se qualcosa va storto
    }
}

module.exports = { getStreamLink };
