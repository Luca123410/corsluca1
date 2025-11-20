const { addonBuilder } = require("stremio-addon-sdk");
const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

const RD = require("./rd");
const Corsaro = require("./corsaro");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- LOGGER ---
app.use((req, res, next) => {
    if (req.url.includes('/stream/') || req.url.includes('/manifest')) {
        console.log(`\n📨 REQ: ${req.method} ${req.url}`);
    }
    next();
});

// --- MANIFEST ---
const manifest = {
    id: "org.community.corsaro-manual-v1",
    version: "1.4.0",
    name: "Corsaro & RD (Final)",
    description: "Ricerca Italiana",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"], 
    behaviorHints: { configurable: true, configurationRequired: true }
};

const builder = new addonBuilder(manifest);

// --- HELPER CONFIGURAZIONE ---
function getConfig(configStr) {
    try { return JSON.parse(Buffer.from(configStr, 'base64').toString()); } 
    catch (e) { return {}; }
}

// --- HELPER TMDB ---
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
    } catch (e) {
        console.error("Errore API TMDB:", e.message);
        return null;
    }
}

// ==========================================
// LOGICA CORE (Separata dal routing)
// ==========================================

async function generateCatalog(type, id, config) {
    if (id === "tmdb_trending" && config?.tmdb) {
        try {
            const url = `https://api.themoviedb.org/3/trending/movie/day?api_key=${config.tmdb}&language=it-IT`;
            const r = await axios.get(url);
            return { metas: r.data.results.map(m => ({
                id: `tmdb:${m.id}`,
                type: "movie",
                name: m.title,
                poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`,
                description: m.overview
            }))};
        } catch (e) { return { metas: [] }; }
    }
    return { metas: [] };
}

async function generateStream(type, id, config) {
    const { rd, tmdb } = config || {};
    console.log(`⚡ Elaborazione ID: ${id}`);

    if (!rd || !tmdb) return { streams: [{ title: "⚠️ Configurazione mancante" }] };
    if (type !== 'movie') return { streams: [] };

    try {
        const movie = await getMovieData(id, tmdb);
        if (!movie) {
            console.log("   ❌ Film non trovato su TMDB");
            return { streams: [{ title: "⚠️ Film non trovato" }] };
        }

        console.log(`   🎬 Cerca: "${movie.title}" (${movie.year})`);
        let magnet = await Corsaro.searchMagnet(movie.title, movie.year);

        if (!magnet && movie.title !== movie.originalTitle) {
            console.log(`   ⚠️ Riprovo titolo originale: "${movie.originalTitle}"`);
            magnet = await Corsaro.searchMagnet(movie.originalTitle, movie.year);
        }

        if (!magnet) return { streams: [{ title: "🚫 Nessun risultato ITA" }] };

        const streamData = await RD.getStreamLink(rd, magnet);
        if (!streamData) return { streams: [{ title: "⚠️ Errore Cache RD" }] };

        return {
            streams: [{
                title: `🦄 RD | Corsaro \n💿 ${streamData.filename}\n📦 ${((streamData.size||0)/1e9).toFixed(2)} GB`,
                url: streamData.url,
                behaviorHints: { notWebReady: false }
            }]
        };
    } catch (error) {
        console.error("🔥 Errore Handler:", error.message);
        return { streams: [{ title: "Errore Interno" }] };
    }
}

// ==========================================
// ROUTING MANUALE (Express Puro)
// ==========================================

// 1. Home Page (Setup)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. Manifest Dinamico
app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...manifest };
    if (config.tmdb && config.rd) {
        m.behaviorHints = { configurable: true, configurationRequired: false };
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.json(m);
});

// 3. Catalog Handler
app.get('/:userConf/catalog/:type/:id.json', async (req, res) => {
    const { userConf, type, id } = req.params;
    const config = getConfig(userConf);
    const result = await generateCatalog(type, id, config);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(result);
});

// 4. Stream Handler
app.get('/:userConf/stream/:type/:id.json', async (req, res) => {
    const { userConf, type, id } = req.params;
    // Stremio aggiunge .json alla fine dell'ID, lo rimuoviamo se presente
    const cleanId = id.replace('.json', '');
    const config = getConfig(userConf);
    
    const result = await generateStream(type, cleanId, config);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(result);
});

// Avvio Server
app.listen(process.env.PORT || 7000, () => {
    console.log("Addon Attivo v1.4.0 (Manual Routing)");
});
