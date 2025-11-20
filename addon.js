const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

const RD = require("./rd");
const Corsaro = require("./corsaro");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// LOGGER
app.use((req, res, next) => {
    if (req.url.includes('/stream/')) console.log(`\n📨 REQ: ${req.method} ${req.url}`);
    next();
});

const manifest = {
    id: "org.community.corsaro-multi",
    version: "1.5.0",
    name: "Corsaro Multi-Result",
    description: "Risultati Multipli ITA",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"], 
    behaviorHints: { configurable: true, configurationRequired: true }
};

const builder = new addonBuilder(manifest);

function getConfig(configStr) {
    try { return JSON.parse(Buffer.from(configStr, 'base64').toString()); } 
    catch (e) { return {}; }
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

// --- LOGICA CATALOGO ---
async function generateCatalog(type, id, config) {
    if (id === "tmdb_trending" && config?.tmdb) {
        try {
            const r = await axios.get(`https://api.themoviedb.org/3/trending/movie/day?api_key=${config.tmdb}&language=it-IT`);
            return { metas: r.data.results.map(m => ({
                id: `tmdb:${m.id}`, type: "movie", name: m.title, poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`
            }))};
        } catch (e) { return { metas: [] }; }
    }
    return { metas: [] };
}

// --- LOGICA STREAM MULTIPLI ---
async function generateStream(type, id, config) {
    const { rd, tmdb } = config || {};
    console.log(`⚡ Elaborazione ID: ${id}`);

    if (!rd || !tmdb) return { streams: [{ title: "⚠️ Configurazione mancante" }] };

    try {
        const movie = await getMovieData(id, tmdb);
        if (!movie) return { streams: [{ title: "⚠️ Film non trovato" }] };

        console.log(`   🎬 Cerca: "${movie.title}" (${movie.year})`);
        
        // 1. Ottieni LISTA di risultati
        let results = await Corsaro.searchMagnet(movie.title, movie.year);

        // Fallback titolo originale se lista vuota
        if (results.length === 0 && movie.title !== movie.originalTitle) {
            console.log(`   ⚠️ Riprovo titolo originale...`);
            results = await Corsaro.searchMagnet(movie.originalTitle, movie.year);
        }

        if (results.length === 0) return { streams: [{ title: "🚫 Nessun risultato trovato" }] };

        console.log(`   🚀 Elaborazione di ${results.length} risultati con Real-Debrid...`);

        // 2. Processa i risultati con RD (in parallelo per velocità)
        // NOTA: Questo "sblocca" i link su RD. 
        const streamPromises = results.map(async (item, index) => {
            const streamData = await RD.getStreamLink(rd, item.magnet);
            if (!streamData) return null;

            return {
                name: `RD | Corsaro`,
                title: `${item.title}\n📦 ${item.size} | 💾 ${streamData.filename}`,
                url: streamData.url,
                behaviorHints: { notWebReady: false }
            };
        });

        const streams = (await Promise.all(streamPromises)).filter(s => s !== null);

        return { streams };

    } catch (error) {
        console.error("🔥 Errore:", error.message);
        return { streams: [{ title: "Errore Interno" }] };
    }
}

// --- ROUTING ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...manifest };
    if (config.tmdb && config.rd) m.behaviorHints = { configurable: true, configurationRequired: false };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(m);
});

app.get('/:userConf/catalog/:type/:id.json', async (req, res) => {
    const { userConf, type, id } = req.params;
    const result = await generateCatalog(type, id, getConfig(userConf));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(result);
});

app.get('/:userConf/stream/:type/:id.json', async (req, res) => {
    const { userConf, type, id } = req.params;
    const result = await generateStream(type, id.replace('.json', ''), getConfig(userConf));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(result);
});

app.listen(process.env.PORT || 7000, () => console.log("Addon Multi-Result Attivo!"));
