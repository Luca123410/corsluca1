const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

const RD = require("./rd");
const Corsaro = require("./corsaro");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Logger
app.use((req, res, next) => {
    if (req.url.includes('/stream/')) console.log(`\n📨 REQ: ${req.method} ${req.url}`);
    next();
});

const manifest = {
    id: "org.community.corsaro-truth",
    version: "2.0.0",
    name: "Corsaro & RD (Truth)",
    description: "Ricerca verificata da Real-Debrid",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"], 
    behaviorHints: { configurable: true, configurationRequired: true }
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// FILTRO REALE: Se Real-Debrid dice che il file è sotto i 250MB, lo nascondiamo.
const REAL_SIZE_FILTER = 250 * 1024 * 1024; 

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

// CATALOGO
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

// STREAM
async function generateStream(type, id, config) {
    const { rd, tmdb } = config || {};
    console.log(`⚡ ID: ${id}`);

    if (!rd || !tmdb) return { streams: [{ title: "⚠️ Configurazione mancante" }] };

    try {
        const movie = await getMovieData(id, tmdb);
        if (!movie) return { streams: [{ title: "⚠️ Film non trovato" }] };

        console.log(`   🎬 Cerca: "${movie.title}" (${movie.year})`);
        
        let results = await Corsaro.searchMagnet(movie.title, movie.year);

        if (results.length === 0 && movie.title !== movie.originalTitle) {
            console.log(`   ⚠️ Riprovo titolo originale...`);
            results = await Corsaro.searchMagnet(movie.originalTitle, movie.year);
        }

        if (results.length === 0) return { streams: [{ title: "🚫 Nessun risultato trovato" }] };

        // Prendiamo più risultati da analizzare (fino a 8) perché ora filtriamo dopo
        const topResults = results.slice(0, 8);
        console.log(`   🚀 Verifico ${topResults.length} magnet con Real-Debrid...`);

        let streams = [];
        let validCount = 0;

        for (const item of topResults) {
            try {
                // Chiediamo a RD
                const streamData = await RD.getStreamLink(rd, item.magnet);
                
                if (streamData) {
                    // ORA ABBIAMO LA VERITÀ: streamData.size è la dimensione reale del file video su RD
                    
                    // FILTRO REALE
                    if (streamData.size < REAL_SIZE_FILTER) {
                        console.log(`      🗑️ SCARTATO FAKE/PICCOLO: ${formatBytes(streamData.size)} - ${item.title.substring(0,15)}...`);
                        continue; // Salta questo risultato
                    }

                    let info = "";
                    if (streamData.type === 'ready') info = `✅ PRONTO | ${formatBytes(streamData.size)}`;
                    else info = `⏳ DOWNLOAD | ${streamData.progress}%`;

                    streams.push({
                        name: `RD | Corsaro`,
                        title: `${item.title}\n${info}\n📄 ${streamData.filename}`,
                        url: streamData.url || "", // URL vuoto se in download, ma Stremio lo mostrerà
                        behaviorHints: { notWebReady: false }
                    });
                    
                    validCount++;
                    console.log(`      ✅ OK (${formatBytes(streamData.size)}): ${item.title.substring(0, 20)}...`);
                    
                    // Se abbiamo trovato 4 risultati validi, ci fermiamo per non rallentare troppo
                    if (validCount >= 4) break;

                } 
                await wait(200); 

            } catch (e) {}
        }

        if (streams.length === 0) {
            return { streams: [{ title: "🚫 Nessun file valido sopra i 250MB trovato." }] };
        }

        return { streams };

    } catch (error) {
        console.error("🔥 Errore:", error.message);
        return { streams: [{ title: "Errore Interno" }] };
    }
}

// ROUTING
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...manifest };
    if (config.tmdb && config.rd) m.behaviorHints = { configurable: true, configurationRequired: false };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(m);
});

app.get('/:userConf/catalog/:type/:id.json', async (req, res) => {
    const result = await generateCatalog(req.params.type, req.params.id, getConfig(req.params.userConf));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(result);
});

app.get('/:userConf/stream/:type/:id.json', async (req, res) => {
    const result = await generateStream(req.params.type, req.params.id.replace('.json', ''), getConfig(req.params.userConf));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(result);
});

app.listen(process.env.PORT || 7000, () => console.log("Addon Attivo v2.0.0 (Truth Filter)"));
