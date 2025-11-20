const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

const CORSARO_URL = "https://ilcorsaronero.link";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

async function searchMagnet(title, year) {
    try {
        const cleanTitle = title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
        const searchUrl = `${CORSARO_URL}/search?q=${encodeURIComponent(cleanTitle)}`;
        
        console.log(`\n--- [DEEP SEARCH] ---`);
        console.log(`🔎 STEP 1: Cerco lista su ${searchUrl}`);

        // STEP 1: Ottieni la lista dei risultati
        const { data } = await axios.get(searchUrl, { headers, httpsAgent, timeout: 10000 });
        
        if (data.includes("Cloudflare")) {
            console.error("⛔ Blocco Cloudflare rilevato.");
            return null;
        }

        const $ = cheerio.load(data);
        let detailUrl = null;
        let foundTitle = "";

        // Cerchiamo un link che sembra un dettaglio torrent
        // Solitamente contengono "/torrent/" o classi specifiche
        $('a').each((i, elem) => {
            if (detailUrl) return; // Ne basta uno

            const href = $(elem).attr('href');
            const text = $(elem).text().toLowerCase();

            // Filtro euristico: deve contenere "torrent" nell'url o essere pertinente
            if (href && (href.includes('/torrent/') || href.includes('details.php'))) {
                // Se c'è l'anno, controlliamo che il titolo lo contenga (se possibile)
                if (year && !text.includes(year) && !text.includes(cleanTitle.toLowerCase())) return;
                
                // Costruiamo l'URL assoluto se è relativo
                if (href.startsWith('http')) detailUrl = href;
                else detailUrl = `${CORSARO_URL}${href.startsWith('/') ? '' : '/'}${href}`;
                
                foundTitle = $(elem).text().trim();
            }
        });

        if (!detailUrl) {
            // PROVA DI RISERVA: Cerca direttamente magnet nella pagina di ricerca (vecchio stile)
            const directMagnet = $('a[href^="magnet:?"]').first().attr('href');
            if (directMagnet) {
                console.log("✅ Trovato magnet diretto nella ricerca!");
                return directMagnet;
            }
            console.log("❌ Nessun risultato o link dettaglio trovato.");
            return null;
        }

        console.log(`🔎 STEP 2: Entro nel dettaglio -> ${foundTitle}`);
        console.log(`   URL: ${detailUrl}`);

        // STEP 2: Entra nella pagina del dettaglio
        const detailPage = await axios.get(detailUrl, { headers, httpsAgent, timeout: 10000 });
        const $d = cheerio.load(detailPage.data);

        // Cerca il magnet nella pagina di dettaglio
        const magnet = $d('a[href^="magnet:?"]').first().attr('href');

        if (magnet) {
            console.log("🚀 MAGNET TROVATO!");
            return magnet;
        } else {
            console.log("❌ Pagina dettaglio aperta, ma nessun magnet trovato.");
            return null;
        }

    } catch (error) {
        console.error("🔥 Errore Scraping:", error.message);
        return null;
    }
}

module.exports = { searchMagnet };
