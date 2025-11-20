const { addonBuilder } = require("stremio-addon-sdk");
const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

// --- IMPORTIAMO I NOSTRI MODULI ---
const RD = require("./rd");
const Corsaro = require("./corsaro");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const manifest = {
    id: "org.community.corsaro-rd-pro",
    version: "1.0.3",
    name: "Corsaro & Real-Debrid ITA",
    description: "Scraping modulare e sblocco Debrid",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Film Popolari" }],
    idPrefixes: ["tmdb"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

const builder = new addonBuilder(manifest);

function getConfig(configStr) {
    try { return JSON.parse(Buffer.from(configStr, 'base64').toString()); } 
    catch (e) { return {}; }
}

// --- CATALOGO ---
builder.defineCatalogHandler(async ({ type, id, config }) => {
    if (!config?.tmdb) return { metas: [] };
    if (type === "movie" && id === "tmdb_trending") {
        try {
            const resp = await axios.get(`https://api.themoviedb.org/3/trending/movie/day?api_key=${config.tmdb}&language=it-IT`);
            return { metas: resp.data.results.map(m => ({
                id: `tmdb:${m.id}`, type: "movie", name: m.title, poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`
            }))};
        } catch (e) { return { metas: [] }; }
    }
    return { metas: [] };
});

// --- STREAM ---
builder.defineStreamHandler(async ({ type, id, config }) => {
    const { rd, tmdb } = config || {};
    if (!rd || !tmdb) return { streams: [{ title: "⚠️ Configurazione mancante" }] };

    const tmdbId = id.split(":")[1];
    console.log(`Richiesta stream per TMDB: ${tmdbId}`);

    try {
        // 1. Ottieni metadati da TMDB
        const meta = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdb}&language=it-IT`);
        const title = meta.data.title;
        const year = meta.data.release_date?.split('-')[0] || '';

        // 2. Cerca il Magnet (Usa il modulo corsaro.js)
        const magnet = await Corsaro.searchMagnet(`${title} ${year}`);
        
        if (!magnet) {
            return { streams: [{ title: "🚫 Nessun risultato su Corsaro" }] };
        }

        // 3. Risolvi il link con RD (Usa il modulo rd.js)
        const streamData = await RD.getStreamLink(rd, magnet);

        if (!streamData) {
            return { streams: [{ title: "⚠️ Errore Real-Debrid o File non in cache" }] };
        }

        return {
            streams: [{
                title: `🚀 RD ITA | ${((streamData.size || 0)/1e9).toFixed(2)} GB\n${streamData.filename}`,
                url: streamData.url
            }]
        };

    } catch (error) {
        console.error("Errore Handler:", error.message);
        return { streams: [{ title: "Errore generico addon" }] };
    }
});

// --- SERVER ---
const addonInterface = builder.getInterface();
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/:userConf/manifest.json', (req, res) => {
    const c = getConfig(req.params.userConf);
    const m = { ...manifest };
    if (c.tmdb && c.rd) m.behaviorHints = { configurable: true, configurationRequired: false };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(m);
});
app.use('/:userConf', (req, res) => {
    const config = getConfig(req.params.userConf);
    addonInterface(req, res, () => res.status(404).send(), { config });
});

app.listen(process.env.PORT || 7000, () => console.log("Addon Modularizzato Attivo!"));
