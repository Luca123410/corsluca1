const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

const CORSARO_URL = "https://ilcorsaronero.link";

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

// CONFIGURAZIONE FILTRO
const MIN_SIZE_BYTES = 300 * 1024 * 1024; // 300 MB

async function searchMagnet(title, year) {
    try {
        const cleanTitle = title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
        const searchUrl = `${CORSARO_URL}/search?q=${encodeURIComponent(cleanTitle)}`;
        
        console.log(`\n--- [MULTI DEEP SEARCH - FIX SIZE] ---`);
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
            if (potentialItems.length >= 8) return; 

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

        console.log(`   ⚡ Trovati ${potentialItems.length} candidati. Scansione dettagli...`);

        if (potentialItems.length === 0) {
            const directMagnet = $('a[href^="magnet:?"]').first().attr('href');
            if (directMagnet) {
                return [{ title: title, magnet: directMagnet, size: "?? GB", sizeBytes: 999999999 }];
            }
            return [];
        }

        // 2. Scansione e Parsing Dimensione (Più robusto)
        const promises = potentialItems.map(async (item) => {
            try {
                const detailPage = await axios.get(item.url, { headers, httpsAgent, timeout: 8000 });
                const $d = cheerio.load(detailPage.data);
                
                const magnet = $d('a[href^="magnet:?"]').first().attr('href');
                if (!magnet) return null;

                const bodyText = $d('body').text();
                
                // FIX: Regex più permissiva (cerca sia "Dimensioni" che pattern numerici diretti con GB/MB)
                const sizeMatch = bodyText.match(/(Dimensioni|Size)?:?\s*(\d+(\.\d+)?\s?(GB|MB|KB))/i);
                let sizeStr = "??";
                let sizeBytes = 0;

                if (sizeMatch) {
                    // sizeMatch[0] è tutto il match, sizeMatch[2] è la parte numerica + unità (es "1.4 GB")
                    // Dobbiamo trovare quale gruppo ha catturato il numero. Di solito è l'ultimo gruppo non nullo.
                    const rawSize = sizeMatch[0].toUpperCase(); 
                    sizeStr = sizeMatch[2] || "??"; 
                    
                    const numMatch = sizeStr.match(/(\d+(\.\d+)?)/);
                    const num = numMatch ? parseFloat(numMatch[0]) : 0;

                    if (rawSize.includes("GB")) sizeBytes = num * 1024**3;
                    else if (rawSize.includes("MB")) sizeBytes = num * 1024**2;
                    else if (rawSize.includes("KB")) sizeBytes = num * 1024;
                }

                // DEBUG: Vediamo cosa ha letto
                // console.log(`   📄 ${item.title.substring(0,15)}... -> Letto: ${sizeStr} (${sizeBytes} bytes)`);

                // --- FILTRO MODIFICATO ---
                // Se sizeBytes è 0 (non siamo riusciti a leggere), ACCETTALO comunque (meglio un falso positivo che niente)
                // Se sizeBytes > 0 MA minore di 300MB, SCARTALO (è sicuramente fake/ost)
                if (sizeBytes > 0 && sizeBytes < MIN_SIZE_BYTES) {
                    console.log(`   🗑️ Scartato (Troppo piccolo): ${sizeStr}`);
                    return null; 
                }

                return {
                    title: item.title,
                    magnet: magnet,
                    size: sizeStr,
                    sizeBytes: sizeBytes || 999999999999 // Se 0, mettilo in cima alla lista per sicurezza
                };
            } catch (e) { return null; }
        });

        const results = (await Promise.all(promises)).filter(r => r !== null);
        results.sort((a, b) => b.sizeBytes - a.sizeBytes);

        console.log(`✅ Estratti ${results.length} risultati validi.`);
        return results;

    } catch (error) {
        console.error("🔥 Errore Scraping:", error.message);
        return [];
    }
}

module.exports = { searchMagnet };
