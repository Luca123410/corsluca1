const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

const CORSARO_URL = "https://ilcorsaronero.link";

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

async function searchMagnet(title, year) {
    try {
        const cleanTitle = title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
        const searchUrl = `${CORSARO_URL}/search?q=${encodeURIComponent(cleanTitle)}`;
        
        console.log(`\n--- [MULTI DEEP SEARCH] ---`);
        console.log(`🔎 Lista: ${searchUrl}`);

        // 1. Scarica la lista dei risultati
        const { data } = await axios.get(searchUrl, { headers, httpsAgent, timeout: 10000 });
        
        if (data.includes("Cloudflare")) {
            console.error("⛔ Cloudflare Blocco.");
            return [];
        }

        const $ = cheerio.load(data);
        let potentialItems = [];

        // 2. Raccogli i link ai dettagli (Max 5-6 per non bloccare tutto)
        $('a').each((i, elem) => {
            if (potentialItems.length >= 6) return; // Limite per velocità

            const href = $(elem).attr('href');
            const text = $(elem).text().trim();

            // Cerchiamo link che portano a /torrent/ o details.php
            if (href && (href.includes('/torrent/') || href.includes('details.php'))) {
                // Filtro Anno (se presente nella richiesta)
                if (year && !text.toLowerCase().includes(year) && !text.toLowerCase().includes(cleanTitle.toLowerCase())) return;

                let fullUrl = href.startsWith('http') ? href : `${CORSARO_URL}${href.startsWith('/') ? '' : '/'}${href}`;
                
                // Evita duplicati
                if (!potentialItems.some(p => p.url === fullUrl)) {
                    potentialItems.push({ url: fullUrl, title: text });
                }
            }
        });

        console.log(`   ⚡ Trovati ${potentialItems.length} candidati. Scansione dettagli...`);

        if (potentialItems.length === 0) {
            // TENTATIVO EXTRA: Magari ci sono magnet diretti nella home (vecchia struttura)
            const directMagnet = $('a[href^="magnet:?"]').first().attr('href');
            if (directMagnet) {
                console.log("   ⚠️ Trovato un solo magnet diretto (Fallback).");
                // Restituiamo un array con un solo elemento
                return [{
                    title: title,
                    magnet: directMagnet,
                    size: "?? GB",
                    sizeBytes: 0
                }];
            }
            return [];
        }

        // 3. Scansione Parallela delle pagine di dettaglio
        const promises = potentialItems.map(async (item) => {
            try {
                const detailPage = await axios.get(item.url, { headers, httpsAgent, timeout: 8000 });
                const $d = cheerio.load(detailPage.data);
                
                // Prendi il magnet dalla pagina dettaglio
                const magnet = $d('a[href^="magnet:?"]').first().attr('href');
                
                if (!magnet) return null;

                // Cerca dimensione
                const bodyText = $d('body').text();
                const sizeMatch = bodyText.match(/Dimensioni:?\s*(\d+(\.\d+)?\s?(GB|MB|KB))/i);
                let sizeStr = sizeMatch ? sizeMatch[1] : "??";
                
                // Calcola bytes per ordinamento
                let sizeBytes = 0;
                if (sizeStr.toUpperCase().includes("GB")) sizeBytes = parseFloat(sizeStr) * 1024**3;
                else if (sizeStr.toUpperCase().includes("MB")) sizeBytes = parseFloat(sizeStr) * 1024**2;

                return {
                    title: item.title,
                    magnet: magnet,
                    size: sizeStr,
                    sizeBytes: sizeBytes
                };
            } catch (e) { return null; }
        });

        // Attendi tutti
        const results = (await Promise.all(promises)).filter(r => r !== null);

        // Ordina per grandezza
        results.sort((a, b) => b.sizeBytes - a.sizeBytes);

        console.log(`✅ Estratti ${results.length} risultati validi.`);
        return results; // ORA È UN ARRAY!

    } catch (error) {
        console.error("🔥 Errore Scraping:", error.message);
        return []; // Ritorna array vuoto su errore
    }
}

module.exports = { searchMagnet };
