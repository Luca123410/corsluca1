const axios = require("axios");

const RD_API = "https://api.real-debrid.com/rest/1.0";
const API_TIMEOUT = 15000; // 15 Secondi timeout

async function getStreamLink(apiKey, magnetLink) {
    let torrentId;
    const headers = { 
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    try {
        // 1. AGGIUNTA MAGNET
        const params = new URLSearchParams();
        params.append('magnet', magnetLink);

        const addResp = await axios.post(`${RD_API}/torrents/addMagnet`, params, { 
            headers, 
            timeout: API_TIMEOUT 
        });
        
        torrentId = addResp.data.id;

    } catch (error) {
        const status = error.response ? error.response.status : "Network Error";
        if (status !== 401) { 
             // Decommenta per debug se necessario
             // console.error(`      ⚠️ RD Add Error [${status}]`);
        }
        return null;
    }

    try {
        // 2. SELEZIONE FILE
        const selectParams = new URLSearchParams();
        selectParams.append('files', 'all');

        await axios.post(`${RD_API}/torrents/selectFiles/${torrentId}`, selectParams, { 
            headers, 
            timeout: API_TIMEOUT 
        });

        // 3. CONTROLLO STATO
        const infoResp = await axios.get(`${RD_API}/torrents/info/${torrentId}`, { 
            headers, 
            timeout: API_TIMEOUT 
        });
        
        const status = infoResp.data.status;
        const progress = parseFloat(infoResp.data.progress || 0);

        // CASO A: PRONTO
        if (status === 'downloaded' && infoResp.data.links && infoResp.data.links.length > 0) {
            const originalLink = infoResp.data.links[0];
            
            const unrestrictParams = new URLSearchParams();
            unrestrictParams.append('link', originalLink);

            const unrestrictResp = await axios.post(`${RD_API}/unrestrict/link`, unrestrictParams, { 
                headers, 
                timeout: API_TIMEOUT 
            });

            return {
                type: 'ready',
                url: unrestrictResp.data.download,
                filename: unrestrictResp.data.filename,
                size: unrestrictResp.data.filesize
            };
        } 
        
        // CASO B: IN DOWNLOAD
        else {
            return { type: 'downloading', progress: progress };
        }

    } catch (error) {
        if (torrentId) {
            return { type: 'downloading', progress: 0 };
        }
        return null;
    }
}

module.exports = { getStreamLink };
