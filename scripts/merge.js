const fs = require('fs');

async function buildMasterDb() {
  console.log("Loading databases...");
  // These are downloaded by the GitHub Action before this script runs
  const anibridge = JSON.parse(fs.readFileSync('anibridge.json', 'utf8'));
  const manami = JSON.parse(fs.readFileSync('manami.json', 'utf8'));

  console.log("Extracting Titles and IDs from Manami...");
  const animeData = {};
  for (const anime of manami.data) {
    const alSource = anime.sources.find(s => s.includes('anilist.co/anime/'));
    if (!alSource) continue;
    const alId = alSource.split('/anime/')[1];
    
    const malSource = anime.sources.find(s => s.includes('myanimelist.net/anime/'));
    const malId = malSource ? malSource.split('/anime/')[1] : null;
    
    const kitSource = anime.sources.find(s => s.includes('kitsu.app/anime/') || s.includes('kitsu.io/anime/'));
    const kitsuId = kitSource ? kitSource.split('/anime/')[1] : null;

    animeData[alId] = {
      titles: [anime.title, ...(anime.synonyms || [])].filter(Boolean),
      malId,
      kitsuId
    };
  }

  console.log("Mapping AniBridge episode ranges...");
  const mappings = {};

  for (const [sourceKey, targets] of Object.entries(anibridge)) {
    if (sourceKey.startsWith('$') || !sourceKey.includes(':')) continue;
    
    // Parse "tmdb_show:95479:s1" -> provider: tmdb, id: 95479, season: s1
    const sourceParts = sourceKey.split(':');
    const sourceProvider = sourceParts[0].replace('_show', '').replace('_movie', '');
    const sourceId = sourceParts[1];
    const sourceSeason = sourceParts[2] || 's1';
    const normalizedSourceKey = `${sourceProvider}:${sourceId}:${sourceSeason}`;

    for (const [targetKey, rangeMap] of Object.entries(targets)) {
      if (targetKey.startsWith('$') || !targetKey.includes(':')) continue;
      
      const targetParts = targetKey.split(':');
      if (targetParts[0] !== 'anilist') continue; // Only need AniList target IDs
      
      const anilistId = targetParts[1];
      if (!animeData[anilistId]) continue; // Skip if Manami doesn't have this AniList ID

      if (!mappings[normalizedSourceKey]) {
        mappings[normalizedSourceKey] = [];
      }

      // Parse "25-47": "1-23"
      for (const [srcRange, tgtRange] of Object.entries(rangeMap)) {
        const [srcStart, srcEnd] = srcRange.split('-').map(Number);
        
        mappings[normalizedSourceKey].push({
          srcStart,
          srcEnd,
          anilistId
        });
      }
    }
  }

  // Sort ranges so lookups are fast and logical
  for (const key in mappings) {
    mappings[key].sort((a, b) => a.srcStart - b.srcStart);
  }

  const finalDb = { anime: animeData, mappings: mappings };
  
  // Save without pretty-printing to save space
  fs.writeFileSync('master-db.json', JSON.stringify(finalDb));
  console.log(`Master DB built successfully! Size: ${(fs.statSync('master-db.json').size / 1024 / 1024).toFixed(2)} MB`);
}

buildMasterDb().catch(console.error);
