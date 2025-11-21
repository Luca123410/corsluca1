const axios = require("axios");

// Endpoint JSON diretto (No Cloudflare)
const API_URL = "https://apibay.org/q.php";

async function searchMagnet(title, year) {
    try {
        // Pulizia base del titolo
        const cleanTitle = title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
        
        // Strategia: Includiamo l'anno direttamente nella query per risultati più precisi
        const query = `${cleanTitle} ${year}`;
        
        // console.log(`   🏴‍☠️ [TPB] Query: ${query}`); // Debug opzionale

        // cat: 200 = Video (Film/TV). Usiamo 0 (All) per sicurezza, come volevi tu.
        const { data } = await axios.get(API_URL, {
            params: { q: query, cat: 0 }, 
            timeout: 8000 // Timeout leggermente ridotto per non rallentare l'Hexa-Engine
        });

        if (!data || data.length === 0 || data[0].name === 'No results returned') {
            return [];
        }

        // Mappiamo i risultati SENZA FILTRI (Lasciamo decidere ad addon.js)
        const results = data.map(item => {
            const name = item.name;
            const hash = item.info_hash;
            const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
            
            // Dimensione
            const sizeBytes = parseInt(item.size);
            const sizeGB = (sizeBytes / 1073741824).toFixed(2);
            const sizeStr = `${sizeGB} GB`;

            return {
                title: name,
                magnet: magnet,
                size: sizeStr,
                sizeBytes: sizeBytes,
                seeders: parseInt(item.seeders) || 0,
                leechers: parseInt(item.leechers) || 0,
                source: "TPB", // Pirate Bay
                infoHash: hash
            };
        });

        // Ordiniamo per Seeders (TPB è famoso per i fake, i seeders aiutano a scremare)
        results.sort((a, b) => b.seeders - a.seeders);
        
        return results;

    } catch (error) {
        // Silenzioso in produzione
        return [];
    }
}

module.exports = { searchMagnet };
