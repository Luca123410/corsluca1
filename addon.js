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
    id: "org.community.corsaro-stable-final-v2",
    version: "10.1.0",
    name: "Corsaro & TPB (FINAL)",
    description: "Sistema stabile e pulito",
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

// CATALOGO e ROUTING INIZIALE omessi per brevità

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
            console.log(`   ⚠️ Fallback titolo originale...`);
            const [corsaroOrig, apiOrig] = await Promise.all([
                Corsaro.searchMagnet(movie.originalTitle, movie.year),
                Apibay.searchMagnet(movie.originalTitle, movie.year)
            ]);
            allResults = [...corsaroOrig, ...apiOrig];
        }

        if (allResults.length === 0) return res.json({ streams: [] });

        // De-duplicate
        const uniqueResults = [];
        const magnetSet = new Set();
        for (const item of allResults) {
            if (!magnetSet.has(item.magnet)) {
                magnetSet.add(item.magnet);
                uniqueResults.push(item);
            }
        }

        // --- NUOVO ORDINAMENTO: Priorità a Seeders > Dimensione ---
        uniqueResults.sort((a, b) => {
            // Corsaro non ha seeders, quindi li forziamo a 0 per la comparazione
            const aSeeders = a.seeders || 0;
            const bSeeders = b.seeders || 0;

            // 1. Ordina per Seeders (dal più alto)
            if (aSeeders !== bSeeders) return bSeeders - aSeeders;
            
            // 2. Poi ordina per Dimensione
            return b.sizeBytes - a.sizeBytes;
        });
        
        const topResults = uniqueResults.slice(0, 15);
        console.log(`   🚀 Verifico ${topResults.length} magnet (Max ${uniqueResults.length})...`);

        let streams = [];

        for (const item of topResults) {
            try {
                const streamData = await RD.getStreamLink(config.rd, item.magnet);
                
                if (streamData) {
                    // FILTRO REALE DIMENSIONE
                    if (streamData.size < REAL_SIZE_FILTER) {
                         console.log(`      🗑️ SCARTATO [${item.source}]: File troppo piccolo (${formatBytes(streamData.size)}).`);
                        continue;
                    }

                    let info = streamData.type === 'ready' ? `✅ PRONTO | ${formatBytes(streamData.size)}` : `⏳ DOWNLOAD ${streamData.progress}%`;
                    let sourceTag = item.source === "Corsaro" ? "🇮🇹 Corsaro" : "🌍 PirateBay";

                    streams.push({
                        name: `RD | ${sourceTag}`,
                        title: `${item.title}\n${info} | 📦 ${formatBytes(streamData.size)}\n📄 ${streamData.filename}`,
                        url: streamData.url || "",
                        behaviorHints: { notWebReady: false }
                    });
                    
                    if(streamData.type === 'ready') console.log(`      ✅ OK [${item.source}]: ${item.title.substring(0, 20)}...`);
                } else {
                    // Log dei fallimenti (i magnet che hai visto sparire)
                    console.log(`      ❌ FALLO MAGNET [${item.source}]: Link non valido o morto.`);
                }
                
                await wait(200);
            } catch (e) {}
        }

        // Resto del codice omesso per brevità...

    } catch (e) {
        res.json({ streams: [] });
    }
});

// ROUTING E ALTRI HANDLERS omessi per brevità, sono identici al codice precedente.
// Se hai bisogno del file intero, chiedi pure.
// ...
