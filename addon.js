const { addonBuilder } = require("stremio-addon-sdk");
const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURAZIONE DEL MANIFEST ---
const manifest = {
    id: "org.community.tmdb-rd-addon",
    version: "1.0.1",
    name: "TMDB & Real-Debrid ITA",
    description: "Catalogo TMDB e Streaming via Real-Debrid",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "tmdb_trending", name: "Film di Tendenza (TMDB)" }
    ],
    idPrefixes: ["tmdb"],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    }
};

const builder = new addonBuilder(manifest);

// Funzione helper per decodificare la configurazione dall'URL
function getConfig(configStr) {
    try {
        return JSON.parse(Buffer.from(configStr, 'base64').toString());
    } catch (e) {
        return {};
    }
}

// --- GESTIONE CATALOGO (TMDB) ---
builder.defineCatalogHandler(async ({ type, id, config }) => {
    const tmdbKey = config?.tmdb;
    
    if (!tmdbKey) {
        return { metas: [{ id: 'config_error', type: 'movie', name: '⚠️ CONFIGURAZIONE MANCANTE: Inserisci TMDB Key' }] };
    }

    if (type === "movie" && id === "tmdb_trending") {
        try {
            // Chiamata API a TMDB per i film popolari
            const url = `https://api.themoviedb.org/3/trending/movie/day?api_key=${tmdbKey}&language=it-IT`;
            const response = await axios.get(url);
            
            const metas = response.data.results.map(item => ({
                id: `tmdb:${item.id}`,
                type: "movie",
                name: item.title,
                poster: `https://image.tmdb.org/t/p/w500${item.poster_path}`,
                description: item.overview,
                releaseInfo: item.release_date ? item.release_date.split('-')[0] : ''
            }));
            return { metas };
        } catch (error) {
            console.error("Errore TMDB Catalog:", error.message);
            return { metas: [] };
        }
    }
    return { metas: [] };
});

// --- GESTIONE STREAM (REAL-DEBRID) ---
builder.defineStreamHandler(async ({ type, id, config }) => {
    const rdKey = config?.rd;
    const tmdbKey = config?.tmdb;

    if (!rdKey || !tmdbKey) {
        return { streams: [{ title: "⚠️ Configurazione mancante" }] };
    }

    console.log(`Richiesta stream per ID: ${id}`);

    // L'ID arriva come "tmdb:12345", lo puliamo
    const tmdbId = id.split(":")[1];

    try {
        // 1. Otteniamo i dettagli del film da TMDB per sapere cosa cercare
        const metaUrl = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}&language=it-IT`;
        const metaData = await axios.get(metaUrl);
        const movieTitle = metaData.data.title;
        const movieYear = metaData.data.release_date.split('-')[0];

        console.log(`Cercando contenuti per: ${movieTitle} (${movieYear})`);

        // =================================================================================
        // --- [STEP 1] LOGICA DI RICERCA MAGNET (Qui va il tuo codice "Corsanero") ---
        // =================================================================================
        // Qui dovresti usare una libreria di scraping o un'altra API per trovare il magnet.
        // Per ora simulo un magnet (QUESTO NON FUNZIONA SENZA UN MAGNET VERO)
        
        let magnetLink = null;
        
        // TODO: Inserisci qui la logica per cercare "movieTitle" su Corsanero e estrarre il magnet
        // Esempio: magnetLink = await cercaSuCorsanero(movieTitle);
        
        if (!magnetLink) {
            // Se non trovi nulla, restituiamo lista vuota o un messaggio
            // Decommenta sotto se vuoi testare con un magnet fisso di prova (Big Buck Bunny)
            // magnetLink = "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c";
            return { streams: [{ title: "Nessun link trovato (Implementare ricerca)" }] };
        }

        // =================================================================================
        // --- [STEP 2] INTEGRAZIONE REAL-DEBRID COMPLETA ---
        // =================================================================================
        
        // A. Aggiungi il Magnet a Real-Debrid
        const addMagnetUrl = "https://api.real-debrid.com/rest/1.0/torrents/addMagnet";
        const addResponse = await axios.post(addMagnetUrl, `magnet=${encodeURIComponent(magnetLink)}`, {
            headers: { Authorization: `Bearer ${rdKey}` }
        });
        
        const torrentId = addResponse.data.id;
        console.log(`Magnet aggiunto a RD. ID: ${torrentId}`);

        // B. Seleziona tutti i file per avviare il download/cache
        const selectFilesUrl = `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`;
        await axios.post(selectFilesUrl, "files=all", {
            headers: { Authorization: `Bearer ${rdKey}` }
        });

        // C. Ottieni le info sul torrent (per prendere il link generato)
        const infoUrl = `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`;
        const infoResponse = await axios.get(infoUrl, {
            headers: { Authorization: `Bearer ${rdKey}` }
        });

        // Prendiamo il link del file più grande (spesso è il film principale)
        const files = infoResponse.data.files;
        const links = infoResponse.data.links; // Array di link hoster originali
        
        // Logica semplice: prendiamo il primo link disponibile generato
        if (links.length === 0) {
            return { streams: [{ title: "RD: File non ancora pronto/cachato" }] };
        }
        const linkToUnrestrict = links[0];

        // D. Sblocca il link (Unrestrict) per ottenere l'URL diretto mp4/mkv
        const unrestrictUrl = "https://api.real-debrid.com/rest/1.0/unrestrict/link";
        const unrestrictResponse = await axios.post(unrestrictUrl, `link=${linkToUnrestrict}`, {
            headers: { Authorization: `Bearer ${rdKey}` }
        });

        const directStreamUrl = unrestrictResponse.data.download;
        const fileName = unrestrictResponse.data.filename;
        const fileSize = (unrestrictResponse.data.filesize / 1024 / 1024 / 1024).toFixed(2) + " GB";

        // Restituisci lo stream a Stremio
        return {
            streams: [
                {
                    title: `🦄 RD Stream | ${fileSize}\n${fileName}`,
                    url: directStreamUrl,
                    behaviorHints: {
                        notWebReady: false, // True se il codec non è supportato dai browser
                        bingeGroup: "rd-streams"
                    }
                }
            ]
        };

    } catch (error) {
        console.error("Errore durante processamento RD:", error.response?.data || error.message);
        return { streams: [{ title: "Errore API Real-Debrid" }] };
    }
});

// --- ROUTING DEL SERVER ---
const addonInterface = builder.getInterface();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Gestione Manifest dinamico
app.get('/:userConf/manifest.json', (req, res) => {
    const userConf = req.params.userConf;
    const config = getConfig(userConf);
    const newManifest = { ...manifest };
    
    // Se configurato, non chiedere più setup
    if (config.tmdb && config.rd) {
        newManifest.behaviorHints = { configurable: true, configurationRequired: false };
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.send(newManifest);
});

// Gestione richieste addon (Catalog, Stream)
app.use('/:userConf', (req, res) => {
    const userConf = req.params.userConf;
    const config = getConfig(userConf);
    addonInterface(req, res, () => res.status(404).send(), { config });
});

const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Addon attivo su http://localhost:${port}`);
});
