const axios = require("axios");
const cheerio = require("cheerio");

const CORSARO_URL = "https://ilcorsaronero.link";

async function searchMagnet(query) {
    try {
        const searchUrl = `${CORSARO_URL}/argh.php?search=${encodeURIComponent(query)}`;
        console.log(`🔎 Scraping: ${searchUrl}`);

        const { data } = await axios.get(searchUrl);
        const $ = cheerio.load(data);
        
        let magnet = null;

        // Cerchiamo il primo magnet disponibile nella tabella
        $('a[href^="magnet:?"]').each((i, elem) => {
            if (magnet) return; // Fermati al primo trovato
            magnet = $(elem).attr('href');
        });

        return magnet; // Ritorna la stringa magnet o null

    } catch (error) {
        console.error("Corsaro Error:", error.message);
        return null;
    }
}

module.exports = { searchMagnet };
