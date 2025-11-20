const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

const CORSARO_URL = "https://ilcorsaronero.link";

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

// Funzione formattazione (solo estetica per i log)
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '??';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

async function searchMagnet(title, year) {
    try {
        const cleanTitle = title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
        const searchUrl = `${CORSARO_URL}/search?q=${encodeURIComponent(cleanTitle)}`;
        
        console.log(`\n--- [MULTI DEEP SEARCH - NO FILTER] ---`);
        console.log(`🔎 Lista: ${searchUrl}`);

        const { data } = await axios.get(searchUrl, { headers, httpsAgent, timeout: 10000 });
        
        if (data.includes("Cloudflare")) {
            console.error("⛔ Blocco Cloudflare.");
            return [];
        }

        const $ = cheerio.load(data);
        let potentialItems = [];

        // 1. Raccogli link
        $('a').each((i, elem) => {
            if (potentialItems.length >= 10) return; 

            const href = $(elem).attr('href');
            const text = $(elem).text().trim();

            if (href && (href.includes('/torrent/') || href.includes('details.php'))) {
                if (year && !text.toLowerCase().includes(year) && !text.toLowerCase().includes(cleanTitle.toLowerCase())) return;

                let fullUrl = href.startsWith('http') ? href : `${CORSARO_URL}${href.startsWith('/') ? '' : '/'}${href}`;
                if (!potentialItems.some(p => p.url === fullUrl)) {
                    potentialItems.push({ url: fullUrl, title: text });
                }
            }
        });

        console.log(`   ⚡ Trovati ${potentialItems.length} candidati.`);

        if (potentialItems.length === 0) {
            const directMagnet = $('a[href^="magnet:?"]').first().attr('href');
            if (directMagnet) {
                return [{ title: title, magnet: directMagnet, size: "Sconosciuta", sizeBytes: 0 }];
            }
            return [];
        }

        const promises = potentialItems.map(async (item) => {
            try {
                const detailPage = await axios.get(item.url, { headers, httpsAgent, timeout: 8000 });
                const $d = cheerio.load(detailPage.data);
                
                const magnet = $d('a[href^="magnet:?"]').first().attr('href');
                if (!magnet) return null;

                // Proviamo a leggere la dimensione giusto per ordinare, ma NON FILTRIAMO
                const bodyText = $d('body').text();
                const sizeMatches = [...bodyText.matchAll(/(\d+(\.\d+)?)\s?(GB|MB|KB|TB)/gi)];
                
                let maxSize = 0;

                sizeMatches.forEach(match => {
                    const num = parseFloat(match[1]);
                    const unit = match[3].toUpperCase();
                    let bytes = 0;
                    if (unit === "TB") bytes = num * 1024**4;
                    else if (unit === "GB") bytes = num * 1024**3;
                    else if (unit === "MB") bytes = num * 1024**2;
                    else if (unit === "KB") bytes = num * 1024;
                    if (bytes > maxSize) maxSize = bytes;
                });

                // NOTA: Nessun controllo if (maxSize < 300MB). Accettiamo tutto.
                // Sarà Real-Debrid a dirci la verità.

                return {
                    title: item.title,
                    magnet: magnet,
                    size: maxSize > 0 ? formatBytes(maxSize) : "??", 
                    sizeBytes: maxSize || 0 // Se 0 va in fondo
                };

            } catch (e) { return null; }
        });

        const results = (await Promise.all(promises)).filter(r => r !== null);
        
        // Ordina per dimensione presunta (ma non esclude nulla)
        results.sort((a, b) => b.sizeBytes - a.sizeBytes);

        console.log(`✅ Passati ${results.length} risultati all'addon.`);
        return results;

    } catch (error) {
        console.error("🔥 Errore:", error.message);
        return [];
    }
}

module.exports = { searchMagnet };
