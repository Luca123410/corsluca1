const axios = require("axios");

// Puoi usare Torrentio o KnightCrawler (che è un clone di Torrentio)
const BASE_URL = "https://torrentio.strem.fun"; 
// Alternativa: "https://knightcrawler.elfhosted.com";

async function searchMagnet(id, type) {
    try {
        // Torrentio accetta solo ID tipo tt1234567 o kistsu:123
        // Se l'ID è tmdb:123, Torrentio spesso non risponde bene, ma ci proviamo.
        
        const url = `${BASE_URL}/stream/${type}/${id}.json`;
        // console.log(`   🧛 "Rubando" risultati da: ${url}`); // Debug opzionale

        const { data } = await axios.get(url, { timeout: 5000 }); // Timeout breve per non bloccare tutto

        if (!data || !data.streams) return [];

        return data.streams.map(stream => {
            // Estraiamo i dati dal titolo formattato di Torrentio
            // Formato tipico: "Titolo\n👤 100 💾 1.5 GB ⚙️ 1337x"
            const lines = stream.title.split('\n');
            const metaLine = lines.find(l => l.includes('💾')); // Cerca la riga con l'icona floppy
            
            let size = "Unknown";
            let seeders = 0;
            let source = "Torrentio";

            if (metaLine) {
                // Estrazione Size
                const sizeMatch = metaLine.match(/💾\s+(.*?)(?:\s|$)/);
                if (sizeMatch) size = sizeMatch[1];

                // Estrazione Seeders
                const seedMatch = metaLine.match(/👤\s+(\d+)/);
                if (seedMatch) seeders = parseInt(seedMatch[1]);

                // Estrazione Source
                const sourceMatch = metaLine.match(/⚙️\s+(.*)/);
                if (sourceMatch) source = `Tio|${sourceMatch[1]}`;
            }

            // Calcolo Size in Bytes per l'ordinamento
            let sizeBytes = 0;
            if (size !== "Unknown") {
                const num = parseFloat(size);
                if (size.includes("GB")) sizeBytes = num * 1024 * 1024 * 1024;
                else if (size.includes("MB")) sizeBytes = num * 1024 * 1024;
            }

            return {
                title: lines[0] || stream.title, // Il titolo pulito è solitamente la prima riga
                size: size,
                sizeBytes: sizeBytes,
                seeders: seeders,
                magnet: stream.infoHash ? `magnet:?xt=urn:btih:${stream.infoHash}` : stream.url,
                source: source,
                infoHash: stream.infoHash // Utile per deduplicazione
            };
        });

    } catch (e) {
        // Silenziamo gli errori per non sporcare il log, visto che è un motore extra
        return [];
    }
}

module.exports = { searchMagnet };
