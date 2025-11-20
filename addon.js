const { addonBuilder } = require("stremio-addon-sdk");
const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- DEFINIZIONE MANIFEST ---
const manifest = {
    id: "org.community.tmdb-rd-addon",
    version: "1.0.0",
    name: "TMDB & Real-Debrid Addon",
    description: "Addon configurabile",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "tmdb_trending", name: "TMDB Trending" }
    ],
    idPrefixes: ["tmdb"],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    }
};

const builder = new addonBuilder(manifest);

// --- HELPER: Decodifica Configurazione ---
function getConfig(configStr) {
    try {
        return JSON.parse(Buffer.from(configStr, 'base64').toString());
    } catch (e) {
        return {};
    }
}

// --- HANDLER 1: CATALOGO (TMDB) ---
builder.defineCatalogHandler(async ({ type, id, config }) => {
    const tmdbKey = config?.tmdb;
    
    if (!tmdbKey) {
        return { metas: [{ id: 'error', type: 'movie', name: 'Inserisci API Key TMDB nelle impostazioni' }] };
    }

    // Esempio chiamata TMDB (Trending Movies)
    if (type === "movie" && id === "tmdb_trending") {
        try {
            const url = `https://api.themoviedb.org/3/trending/movie/day?api_key=${tmdbKey}&language=it-IT`;
            const response = await axios.get(url);
            
            const metas = response.data.results.map(item => ({
                id: `tmdb:${item.id}`,
                type: "movie",
                name: item.title,
                poster: `https://image.tmdb.org/t/p/w500${item.poster_path}`,
                description: item.overview
            }));
            return { metas };
        } catch (error) {
            console.error("Errore TMDB:", error.message);
            return { metas: [] };
        }
    }
    return { metas: [] };
});

// --- HANDLER 2: STREAM (Real-Debrid) ---
builder.defineStreamHandler(async ({ type, id, config }) => {
    const rdKey = config?.rd;
    
    if (!rdKey || !id.startsWith("tmdb:")) {
        return { streams: [] };
    }

    const tmdbId = id.split(":")[1];
    console.log(`Richiesto stream per TMDB ID: ${tmdbId}`);

    // ---------------------------------------------------------
    // PASSO A: Trovare un Magnet Link / Hash
    // Qui devi implementare la tua logica per trovare un hash torrent
    // basandoti sull'ID di TMDB (titolo, anno, etc.)
    // ---------------------------------------------------------
    
    // Esempio fittizio (per far funzionare il codice, devi sostituirlo con la tua ricerca):
    const magnetLink = "magnet:?xt=urn:btih:ESEMPIO_HASH_TORRENT_DA_CERCARE..."; 
    // Se non trovi nulla: return { streams: [] };

    try {
        // ---------------------------------------------------------
        // PASSO B: Aggiungere a Real-Debrid
        // ---------------------------------------------------------
        
        // 1. Verifica se il file è già nella cache di RD (opzionale ma consigliato)
        // GET https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/{hash}

        // 2. Aggiungi Magnet a RD
        const addMagnet = await axios.post(
            "https://api.real-debrid.com/rest/1.0/torrents/addMagnet", 
            `magnet=${encodeURIComponent(magnetLink)}`, 
            { headers: { Authorization: `Bearer ${rdKey}` } }
        );
        
        const torrentId = addMagnet.data.id;

        // 3. Seleziona i file (in genere "all" o il video principale)
        await axios.post(
            "https://api.real-debrid.com/rest/1.0/torrents/selectFiles/" + torrentId,
            "files=all",
            { headers: { Authorization: `Bearer ${rdKey}` } }
        );

        // 4. Ottieni info sul torrent per prendere il link di download
        const torrentInfo = await axios.get(
            "https://api.real-debrid.com/rest/1.0/torrents/info/" + torrentId,
            { headers: { Authorization: `Bearer ${rdKey}` } }
        );

        // Prendi il primo link generato (link originale hoster)
        const originalLink = torrentInfo.data.links[0];

        // 5. "Unrestrict" il link (ottieni il link diretto streamabile)
        const unrestrict = await axios.post(
            "https://api.real-debrid.com/rest/1.0/unrestrict/link",
            `link=${originalLink}`,
            { headers: { Authorization: `Bearer ${rdKey}` } }
        );

        return {
            streams: [{
                title: "⚡ Real-Debrid Stream 1080p",
                url: unrestrict.data.download,
                behaviorHints: { notWebReady: false }
            }]
        };

    } catch (error) {
        console.error("Errore Real-Debrid:", error.response?.data || error.message);
        return { streams: [{ title: "Errore RD o nessun link trovato" }] };
    }
});

// --- SERVER EXPRESS ---
const addonInterface = builder.getInterface();

// Route per la pagina di configurazione
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Route per il manifest con configurazione
app.get('/:userConf/manifest.json', (req, res) => {
    const userConf = req.params.userConf;
    const config = getConfig(userConf);
    // Cloniamo il manifest per non modificare l'originale globale
    const responseManifest = { ...manifest };
    
    // Se la configurazione è valida, non chiediamo più di configurare
    if (config.tmdb && config.rd) {
        responseManifest.behaviorHints = { configurable: true, configurationRequired: false };
    }
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.send(responseManifest);
});

// Route per tutte le risorse (catalog, stream, meta)
app.use('/:userConf', (req, res, next) => {
    const userConf = req.params.userConf;
    const config = getConfig(userConf);
    
    // Passiamo la configurazione al router dell'SDK
    addonInterface(req, res, () => {
        res.status(404).send();
    }, { config });
});

const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Addon attivo sulla porta ${port}`);
});
