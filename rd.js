const axios = require("axios");

const RD_API = "https://api.real-debrid.com/rest/1.0";
const API_TIMEOUT = 5000; // 5 secondi di timeout massimo per ogni chiamata RD

async function getStreamLink(apiKey, magnetLink) {
    try {
        const headers = { Authorization: `Bearer ${apiKey}` };

        // 1. Aggiungi Magnet
        const addResp = await axios.post(`${RD_API}/torrents/addMagnet`, 
            `magnet=${encodeURIComponent(magnetLink)}`, 
            { headers, timeout: API_TIMEOUT } // Aggiunto timeout
        );
        const torrentId = addResp.data.id;

        // 2. Seleziona file
        await axios.post(`${RD_API}/torrents/selectFiles/${torrentId}`, 
            "files=all", 
            { headers, timeout: API_TIMEOUT } // Aggiunto timeout
        );

        // 3. Controlla stato
        const infoResp = await axios.get(`${RD_API}/torrents/info/${torrentId}`, 
            { headers, timeout: API_TIMEOUT } // Aggiunto timeout
        );
        const status = infoResp.data.status;
        const progress = parseFloat(infoResp.data.progress);

        if (status === 'downloaded' && infoResp.data.links?.length > 0) {
            const originalLink = infoResp.data.links[0];
            const unrestrictResp = await axios.post(`${RD_API}/unrestrict/link`, 
                `link=${originalLink}`, 
                { headers, timeout: API_TIMEOUT } // Aggiunto timeout
            );
            return {
                type: 'ready',
                url: unrestrictResp.data.download,
                filename: unrestrictResp.data.filename,
                size: unrestrictResp.data.filesize
            };
        } 
        
        else if (status === 'downloading' || status === 'magnet_conversion' || status === 'waiting_files_selection' || progress < 100) {
            return { type: 'downloading', progress: progress };
        }

        // Se non è scaricato, non si sta scaricando e non è un magnet in attesa, diamo null
        return null;

    } catch (error) {
        // Se c'è un timeout o un errore RD, viene gestito come 'null'
        // console.error("RD Single Error:", error.message);
        return null; 
    }
}

module.exports = { getStreamLink };
