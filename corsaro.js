const axios = require("axios");
const cheerio = require("cheerio");

const CORSARO_URL = "https://ilcorsaronero.link";
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

async function searchMagnet(title, year) {
    try {
        const cleanTitle = title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
        const searchUrl = `${CORSARO_URL}/search?q=${encodeURIComponent(cleanTitle + (year ? ` ${year}` : ""))}`;

        const { data } = await axios.get(searchUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(data);

        const results = [];

        // Prendi le righe della tabella
        $("tr").each((i, row) => {
            if (i === 0) return; // salta header
            const cells = $(row).find("td");
            if (cells.length < 6) return;

            const titleLink = cells.eq(1).find("a").first();
            const title = titleLink.text().trim();
            if (!title) return;

            const detailUrl = CORSARO_URL + titleLink.attr("href");

            const sizeStr = cells.eq(4).text().trim();
            const sizeBytes = convertSize(sizeStr);

            const seeders = parseInt(cells.eq(5).text()) || 0;
            const leechers = parseInt(cells.eq(6).text()) || 0;

            results.push({ detailUrl, title, sizeBytes, seeders, leechers });
        });

        // Prendi magnet dalle pagine dettaglio (max 20)
        const magnetResults = [];
        for (const item of results.slice(0, 20)) {
            try {
                const { data: detailData } = await axios.get(item.detailUrl, { headers, timeout: 10000 });
                const magnetMatch = detailData.match(/magnet:\?xt=urn:btih:([a-zA-Z0-9]{40})/);
                if (magnetMatch) {
                    const fullMagnet = `magnet:?xt=urn:btih:${magnetMatch[1]}&dn=${encodeURIComponent(item.title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org:1337/announce&tr=udp%3A%2F%2Fopen.tracker.cl:1337/announce`;
                    magnetResults.push({
                        title: item.title,
                        magnet: fullMagnet,
                        size: (item.sizeBytes / 1073741824).toFixed(2) + " GB",
                        sizeBytes: item.sizeBytes,
                        seeders: item.seeders,
                        source: "Corsaro"
                    });
                }
            } catch (e) {}
        }

        return magnetResults;
    } catch (error) {
        console.error("Errore Corsaro:", error.message);
        return [];
    }
}

function convertSize(str) {
    const m = str.match(/([\d.]+)\s*(GB|MB)/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    return m[2].toUpperCase() === "GB" ? n * 1073741824 : n * 1048576;
}

module.exports = { searchMagnet };
