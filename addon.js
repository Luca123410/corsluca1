const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

// MODULI ATTIVI (5 Motori)
const RD = require("./rd");
const Corsaro = require("./corsaro");
const Apibay = require("./apibay");
const TorrentMagnet = require("./torrentmagnet");
const UIndex = require("./uindex"); 

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Logger
app.use((req, res, next) => {
    if (req.url.includes('/stream/') || req.url.includes('/catalog/')) {
        console.log(`\n📨 REQ: ${req.method} ${req.url}`);
    }
    next();
});

const manifest = {
    id: "org.community.corsaro-final-unleashed",
    version: "21.0.1", // Bump versione
    name: "Corsaro + Global (UNLEASHED)",
    description: "5 Motori - Fix Visualizzazione",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// FILTRO DIMENSIONE REALE (Solo se RD risponde)
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

async function getMetadata(id, type, tmdbKey) {
    try {
        let tmdbId = id;
        let seasonNum, episodeNum;
        if (type === 'series' && id.includes(':')) {
            const parts = id.split(':');
            tmdbId = parts[0]; seasonNum = parseInt(parts[1]); episodeNum = parseInt(parts[2]);
        }
        let details;
        if (tmdbId.startsWith('tt')) {
            const res = await axios.get(`https://api.themoviedb.org/3/find/${tmdbId}?api_key=${tmdbKey}&language=it-IT&external_source=imdb_id`);
            if (type === 'movie' && res.data.movie_results?.length > 0) details = res.data.movie_results[0];
            else if (type === 'series' && res.data.tv_results?.length > 0) details = res.data.tv_results[0];
        } else if (tmdbId.startsWith('tmdb:')) {
            const cleanId = tmdbId.split(':')[1];
            const res = await axios.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${cleanId}?api_key=${tmdbKey}&language=it-IT`);
            details = res.data;
        }
        if (details) {
            return {
                title: details.title || details.name, originalTitle: details.original_title || details.original_name, year: (details.release_date || details.first_air_date)?.split('-')[0],
                isSeries: type === 'series', season: seasonNum, episode: episodeNum
            };
        }
        return null;
    } catch (e) { return null; }
}

// CATALOGO
async function generateCatalog(type, id, config) {
    if (id === "tmdb_trending" && config.tmdb) {
        try {
            const r = await axios.get(`https://api.themoviedb.org/3/trending/movie/day?api_key=${config.tmdb}&language=it-IT`);
            return { metas: r.data.results.map(m => ({
                id: `tmdb:${m.id}`, type: "movie", name: m.title, poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`
            }))};
        } catch (e) { return { metas: [] }; }
    }
    return { metas: [] };
}

// STREAM HANDLER (CORRETTO PER VISUALIZZAZIONE)
async function generateStream(type, id, config) {
    const { rd, tmdb } = config || {};
    console.log(`⚡ ID: ${id}`);
    if (!rd || !tmdb) return { streams: [{ title: "⚠️ Configurazione mancante" }] };

    try {
        const metadata = await getMetadata(id, type, tmdb);
        if (!metadata) return { streams: [{ title: "⚠️ Metadata non trovato" }] };

        let searchBase;
        if (metadata.isSeries) {
            const s = String(metadata.season).padStart(2, '0');
            const e = String(metadata.episode).padStart(2, '0');
            searchBase = `${metadata.title} S${s}E${e}`;
        } else {
            searchBase = `${metadata.title} ${metadata.year}`;
        }

        // RICERCA PENTA (5 MOTORI)
        const [corsaroRes, uindexRes, apiRes, magnetRes] = await Promise.all([
            Corsaro.searchMagnet(searchBase, metadata.year).catch(()=>[]),
            UIndex.searchMagnet(searchBase, metadata.year).catch(()=>[]),
            Apibay.searchMagnet(searchBase, metadata.year).catch(()=>[]),
            TorrentMagnet.searchMagnet(searchBase, metadata.year).catch(()=>[])
        ]);

        let allResults = [...corsaroRes, ...uindexRes, ...apiRes, ...magnetRes];

        // Fallback Titolo Originale
        if (allResults.length === 0 && metadata.title !== metadata.originalTitle) {
            const searchBaseOrig = metadata.isSeries ? `${metadata.originalTitle} S${String(metadata.season).padStart(2, '0')}E${String(metadata.episode).padStart(2, '0')}` : `${metadata.originalTitle} ${metadata.year}`;
            const [corsaroOrig, uindexOrig, apiOrig, magnetOrig] = await Promise.all([
                Corsaro.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[]),
                UIndex.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[]),
                Apibay.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[]),
                TorrentMagnet.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[])
            ]);
            allResults = [...corsaroOrig, ...uindexOrig, ...apiOrig, ...magnetOrig];
        }

        if (allResults.length === 0) return { streams: [{ title: `🚫 Nessun risultato trovato` }] };

        // Deduplicazione
        const uniqueResults = [];
        const magnetSet = new Set();
        for (const item of allResults) {
            const hashMatch = item.magnet.match(/btih:([A-F0-9]{40})/i);
            const key = hashMatch ? hashMatch[1].toUpperCase() : item.magnet;
            if (!magnetSet.has(key)) {
                magnetSet.add(key);
                uniqueResults.push(item);
            }
        }

        // Ordinamento per dimensione presunta (così i migliori sono in cima)
        uniqueResults.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
        
        const topResults = uniqueResults.slice(0, 20);
        console.log(`   🚀 Verifico ${topResults.length} magnet...`);

        let streams = [];
        for (const item of topResults) {
            try {
                const streamData = await RD.getStreamLink(config.rd, item.magnet);
                
                // 1. FILTRO RIGIDO: Se RD ci dà la dimensione, usiamo SOLO quella
                if (streamData && streamData.type === 'ready') {
                    if (streamData.size && streamData.size < REAL_SIZE_FILTER) {
                        console.log(`      🗑️ SCARTATO [${item.source}]: ${formatBytes(streamData.size)} (Sotto soglia)`);
                        continue; 
                    }
                }

                let sourceTag = `RD | ${item.source}`;
                if (item.source === "Corsaro" || item.source === "UIndex") sourceTag += " 🇮🇹";
                else sourceTag += " 🌍";

                if (streamData) {
                    // SUCCESSO RD: Usiamo i dati veri
                    let info = streamData.type === 'ready' ? `✅ PRONTO` : `⏳ DOWNLOAD ${streamData.progress}%`;
                    let finalSize = streamData.size ? formatBytes(streamData.size) : (item.size || "??");

                    streams.push({
                        name: sourceTag,
                        title: `${item.title}\n${info} | 📦 ${finalSize}\n📄 ${streamData.filename || "File"}`,
                        url: streamData.url || "",
                        behaviorHints: { notWebReady: false }
                    });
                } else {
                    // FALLIMENTO RD (TIMEOUT): Gestione intelligente "Falso 4MB"
                    // Se RD non risponde, non fidiamoci della dimensione del torrent se sembra strana
                    let fakeSize = item.size || "??";
                    // Se dice 4 MB o Byte, nascondiamolo per non spaventare l'utente
                    if(fakeSize.includes("MB") && parseInt(fakeSize) < 100) fakeSize = "?? GB";
                    if(fakeSize.toLowerCase().endsWith("b") && !fakeSize.toLowerCase().includes("k")) fakeSize = "?? GB";

                    streams.push({
                        name: `⚠️ ${item.source}`,
                        // Messaggio cambiato: invece di "Link non verificato" diciamo "Check Saltato"
                        // E mostriamo "Dimensione Ignota" invece di "4 MB"
                        title: `${item.title}\n⚡ Link Diretto (RD Timeout)\n📦 Dimensione: Ignota (Click per provare)`, 
                        url: item.magnet,
                        behaviorHints: { notWebReady: true }
                    });
                }
                await wait(150);
            } catch (e) {
                 // CATCH ERRORI: Stessa logica del fallback
                 streams.push({
                    name: `⚠️ ${item.source}`,
                    title: `${item.title}\n⚡ Link Diretto (Errore API)\n📦 Dimensione: Ignota (Click per provare)`, 
                    url: item.magnet,
                    behaviorHints: { notWebReady: true }
                });
            }
        }

        if (streams.length === 0) return { streams: [{ title: "🚫 Nessun file valido." }] };
        return { streams };

    } catch (error) {
        console.error("🔥 Errore fatale:", error.message);
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
    const streams = await generateStream(req.params.type, req.params.id.replace('.json', ''), getConfig(req.params.userConf));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(streams);
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon UNLEASHED v21.0.1 pronto!`));
