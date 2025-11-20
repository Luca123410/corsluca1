const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

// MODULI ATTIVI
const RD = require("./rd");
const Corsaro = require("./corsaro");
const Apibay = require("./apibay");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    if (req.url.includes('/stream/')) console.log(`\n📨 REQ: ${req.method} ${req.url}`);
    next();
});

const manifest = {
    id: "org.community.corsaro-filter",
    version: "12.0.0",
    name: "Corsaro & TPB (Final Filter)",
    description: "Filtro unificato di qualità",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"], 
    behaviorHints: { configurable: true, configurationRequired: true }
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const REAL_SIZE_FILTER = 250 * 1024 * 1024; // 250 MB

function formatBytes(bytes) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getConfig(configStr) {
    try { return JSON.parse(Buffer.from(configStr, 'base64').toString()); } catch (e) { return {}; }
}

async function getMovieData(id, tmdbKey) {
    try {
        let url;
        if (id.startsWith('tt')) {
            url = `https://api.themoviedb.org/3/find/${id}?api_key=${tmdbKey}&language=it-IT&external_source=imdb_id`;
            const res = await axios.get(url);
            if (res.data.movie_results?.length > 0) {
                const m = res.data.movie_results[0];
                return { title: m.title, originalTitle: m.original_title, year: m.release_date?.split('-')[0] };
            }
        } else if (id.startsWith('tmdb:')) {
            const cleanId = id.split(':')[1];
            url = `https://api.themoviedb.org/3/movie/${cleanId}?api_key=${tmdbKey}&language=it-IT`;
            const res = await axios.get(url);
            return { title: res.data.title, originalTitle: res.data.original_title, year: res.data.release_date?.split('-')[0] };
        }
        return null;
    } catch (e) { return null; }
}

// --- NUOVA FUNZIONE DI FILTRO AVANZATO (Basata sulla logica APIBAY) ---
function applyAdvancedFilters(items, year) {
    const resultsMap = new Map();
    const currentYear = parseInt(year);

    const checkKeywords = (nameUpper) => {
        return nameUpper.includes("ITA") || nameUpper.includes("ITALIAN") || nameUpper.includes("MULTI") || nameUpper.includes("DUAL") || nameUpper.includes("MD") || nameUpper.includes("SUB ITA") || nameUpper.includes("SUB-ITA") || nameUpper.includes("AC3 ITA") || nameUpper.includes("DTS ITA") || nameUpper.includes("FORCED ITA");
    };

    for (const item of items) {
        const nameUpper = item.title.toUpperCase();

        // 1. Filtro Lingua: Applica il filtro rigido APIBAY a TUTTI
        if (!checkKeywords(nameUpper)) continue;

        // 2. Filtro Anno Flessibile (Saltiamo solo se l'anno è molto diverso)
        if (year && currentYear) {
            if (![currentYear - 1, currentYear, currentYear + 1].some(ay => item.title.includes(ay))) {
                // Se non c'è l'anno esatto o +/- 1 anno, lo scartiamo
                if (!item.source.includes("Corsaro")) continue; // Solo Corsaro ha un po' di tolleranza
            }
        }
        
        // 3. Deduplicazione (Priorità Seeders > Dimensione)
        const hash = item.magnet.match(/btih:([a-zA-Z0-9]{40})/);
        if (!hash) continue; // Hash malformato

        if (resultsMap.has(hash[1])) {
            const existing = resultsMap.get(hash[1]);
            // Prioritizza i seeders se ci sono, altrimenti la dimensione
            if (item.seeders && existing.seeders && item.seeders <= existing.seeders) continue;
            if (item.sizeBytes <= existing.sizeBytes && !item.seeders) continue;
        }

        resultsMap.set(hash[1], item);
    }

    const finalResults = Array.from(resultsMap.values());
    
    // Ordina (per seeders e dimensione)
    finalResults.sort((a, b) => {
        if ((a.seeders || 0) !== (b.seeders || 0)) return b.seeders - a.seeders;
        return b.sizeBytes - a.sizeBytes;
    });

    return finalResults;
}

// CATALOGO e routing omessi per brevità...

// STREAM
app.get('/:userConf/stream/:type/:id.json', async (req, res) => {
    const { userConf, type, id } = req.params;
    const config = getConfig(userConf);
    const cleanId = id.replace('.json', '');
    
    if (!config.rd || !config.tmdb) return res.json({ streams: [] });

    try {
        const movie = await getMovieData(cleanId, config.tmdb);
        if (!movie) return res.json({ streams: [] });

        console.log(`   🎬 Cerca: "${movie.title}" (${movie.year})`);
        
        const [corsaroRes, apiRes] = await Promise.all([
            Corsaro.searchMagnet(movie.title, movie.year),
            Apibay.searchMagnet(movie.title, movie.year)
        ]);

        let allResults = [...corsaroRes, ...apiRes];

        if (allResults.length === 0 && movie.title !== movie.originalTitle) {
            const [corsaroOrig, apiOrig] = await Promise.all([
                Corsaro.searchMagnet(movie.originalTitle, movie.year),
                Apibay.searchMagnet(movie.originalTitle, movie.year)
            ]);
            allResults = [...corsaroOrig, ...apiOrig];
        }
        
        // --- APPLICA IL FILTRO AVANZATO AI RISULTATI GREZZI ---
        const uniqueResults = applyAdvancedFilters(allResults, movie.year);

        if (uniqueResults.length === 0) {
             console.log("   🚫 Tutti i magnet ITA sono stati filtrati (troppo vecchi/mancano keyword).");
             return res.json({ streams: [{ title: "🚫 Nessun file valido ITA/MULTI." }] });
        }
        
        uniqueResults.sort((a, b) => {
            const aSeeders = a.seeders || 0;
            const bSeeders = b.seeders || 0;

            if (aSeeders !== bSeeders) return bSeeders - aSeeders;
            return b.sizeBytes - a.sizeBytes;
        });

        const topResults = uniqueResults.slice(0, 15);
        console.log(`   🚀 Verifico ${topResults.length} magnet (Finali).`);

        let streams = [];

        for (const item of topResults) {
            try {
                const streamData = await RD.getStreamLink(config.rd, item.magnet);
                
                if (streamData) {
                    if (streamData.size < REAL_SIZE_FILTER) {
                        console.log(`      🗑️ SCARTATO [${item.source}]: File troppo piccolo.`);
                        continue;
                    }

                    let info = streamData.type === 'ready' ? `✅ PRONTO | ${formatBytes(streamData.size)}` : `⏳ DOWNLOAD ${streamData.progress}%`;
                    let sourceTag = item.source === "Corsaro" ? "RD | Corsaro 🇮🇹" : "RD | PirateBay 🏴‍☠️";

                    streams.push({
                        name: sourceTag,
                        title: `${item.title}\n${info}\n📄 ${streamData.filename}`,
                        url: streamData.url || "",
                        behaviorHints: { notWebReady: false }
                    });
                    
                    if(streamData.type === 'ready') console.log(`      ✅ OK [${item.source}]: ${item.title.substring(0, 20)}...`);
                } else {
                    console.log(`      ❌ FALLO MAGNET [${item.source}]: Link morto/corrotto. (Passo al successivo)`);
                }
                
                await wait(200);
            } catch (e) {}
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json({ streams });

    } catch (e) {
        res.json({ streams: [] });
    }
});

// ROUTING INIZIALE E LISTEN (omessi per brevità)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...manifest };
    if (config.tmdb && config.rd) m.behaviorHints = { configurable: true, configurationRequired: false };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(m);
});
app.listen(process.env.PORT || 7000, () => console.log("Addon STABILISSIMO (Final) Ready!"));
