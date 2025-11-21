const axios = require("axios");

const PROVIDERS = [
    { 
        name: "Torrentio", 
        url: "https://torrentio.strem.fun",
        parseType: "torrentio" 
    },
    { 
        name: "KnightCrawler", 
        url: "https://knightcrawler.elfhosted.com",
        parseType: "torrentio" 
    },
    { 
        name: "MediaFusion", 
        url: "https://mediafusion.elfhosted.com",
        parseType: "mediafusion" 
    }
];

async function fetchFromProvider(provider, id, type) {
    try {
        const url = `${provider.url}/stream/${type}/${id}.json`;
        const { data } = await axios.get(url, { timeout: 7000 }); 

        if (!data || !data.streams) return [];

        return data.streams.map(stream => {
            let title = "Unknown";
            let size = "Unknown";
            let sizeBytes = 0;
            let seeders = 0;
            let source = provider.name;

            // --- PARSING LOGIC ---
            
            // A. LOGICA TORRENTIO / KNIGHTCRAWLER
            if (provider.parseType === "torrentio") {
                const lines = stream.title.split('\n');
                title = lines[0] || stream.title;
                
                const metaLine = lines.find(l => l.includes('💾'));
                if (metaLine) {
                    const sizeMatch = metaLine.match(/💾\s+(.*?)(?:\s|$)/);
                    if (sizeMatch) size = sizeMatch[1];
                    const seedMatch = metaLine.match(/👤\s+(\d+)/);
                    if (seedMatch) seeders = parseInt(seedMatch[1]);
                    
                    const providerPrefix = provider.name === "Torrentio" ? "Tio" : "KC";
                    const sourceMatch = metaLine.match(/⚙️\s+(.*)/);
                    if (sourceMatch) source = `${providerPrefix}|${sourceMatch[1]}`;
                }
            } 
            // B. LOGICA MEDIAFUSION (FIXED)
            else if (provider.parseType === "mediafusion") {
                const desc = stream.description || stream.title; 
                const lines = desc.split('\n');
                
                // Titolo base (pulizia emoji cartelle)
                title = lines[0].replace("📂 ", "").replace("/", "").trim();
                
                // 🔍 FIX IMPORTANTE: CERCA L'ITALIANO OVUNQUE
                // Se troviamo una bandiera o la scritta ITA in qualsiasi parte della descrizione,
                // la aggiungiamo forzatamente al titolo. Così il filtro ITA STRICT non lo cancella.
                const fullText = desc.toLowerCase();
                const hasHiddenIta = fullText.includes("🇮🇹") || 
                                     fullText.includes("italian") || 
                                     (fullText.includes("audio") && fullText.includes("ita"));

                if (hasHiddenIta && !title.toLowerCase().includes("ita")) {
                    title += " [ITA]"; // Timbralo come Italiano!
                }

                const seedLine = lines.find(l => l.includes("👤"));
                if (seedLine) {
                    seeders = parseInt(seedLine.split("👤 ")[1]) || 0;
                }

                const sourceLine = lines.find(l => l.includes("🔗"));
                if (sourceLine) {
                    source = `MF|${sourceLine.split("🔗 ")[1]}`;
                } else {
                    source = "MediaFusion";
                }

                if (stream.behaviorHints && stream.behaviorHints.videoSize) {
                    sizeBytes = stream.behaviorHints.videoSize;
                    size = formatBytes(sizeBytes);
                }
            }

            if (sizeBytes === 0 && size !== "Unknown") {
                const num = parseFloat(size);
                if (size.includes("GB")) sizeBytes = num * 1024 * 1024 * 1024;
                else if (size.includes("MB")) sizeBytes = num * 1024 * 1024;
            }

            return {
                title: title,
                size: size,
                sizeBytes: sizeBytes,
                seeders: seeders,
                magnet: stream.infoHash ? `magnet:?xt=urn:btih:${stream.infoHash}` : stream.url,
                source: source,
                infoHash: stream.infoHash || null
            };
        });

    } catch (e) {
        return [];
    }
}

function formatBytes(bytes) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

async function searchMagnet(id, type) {
    const promises = PROVIDERS.map(p => fetchFromProvider(p, id, type));
    const resultsArray = await Promise.all(promises);
    return resultsArray.flat();
}

module.exports = { searchMagnet };
