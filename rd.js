const axios = require("axios");

async function getStreamLink(apiKey, magnetLink) {
    if (!apiKey || !magnetLink) return null;

    try {
        // 1. Estrai l'Hash
        const hashMatch = magnetLink.match(/btih:([a-zA-Z0-9]+)/);
        const hash = hashMatch ? hashMatch[1].toLowerCase() : null;
        if (!hash) return null;

        // 2. CONTROLLO SICUREZZA (Anti-Ban)
        // Chiediamo se è disponibile PRIMA di aggiungerlo. Questo evita il blocco API.
        const availUrl = `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hash}`;
        const availRes = await axios.get(availUrl, { 
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 5000 
        });
        
        const dataset = availRes.data[hash];
        // Se non c'è in cache, ci fermiamo subito. Niente addMagnet -> Niente Ban.
        if (!dataset || !dataset.rd || dataset.rd.length === 0) {
            return null; 
        }

        // 3. Aggiungi Magnet (Solo se sicuro)
        const addUrl = "https://api.real-debrid.com/rest/1.0/torrents/addMagnet";
        const addRes = await axios.post(addUrl, `magnet=${encodeURIComponent(magnetLink)}`, {
            headers: { Authorization: `Bearer ${apiKey}` }
        });
        const torrentId = addRes.data.id;

        // 4. Seleziona File
        const selectUrl = `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`;
        await axios.post(selectUrl, "files=all", {
            headers: { Authorization: `Bearer ${apiKey}` }
        });

        // 5. Ottieni Link
        const infoUrl = `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`;
        const infoRes = await axios.get(infoUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
        const originalLink = infoRes.data.links[0];
        
        if (!originalLink) return null;

        // 6. Sblocca Link
        const unrestrictUrl = "https://api.real-debrid.com/rest/1.0/unrestrict/link";
        const unrestrictRes = await axios.post(unrestrictUrl, `link=${originalLink}`, {
            headers: { Authorization: `Bearer ${apiKey}` }
        });

        return {
            url: unrestrictRes.data.download,
            filename: unrestrictRes.data.filename,
            size: unrestrictRes.data.filesize
        };

    } catch (error) {
        // Se becchi l'errore 429 o 503, vuol dire che devi aspettare
        if (error.response && error.response.status === 429) {
            console.log("⚠️ RATE LIMIT: Rallenta!");
        }
        return null;
    }
}

module.exports = { getStreamLink };
