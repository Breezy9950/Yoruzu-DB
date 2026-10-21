const fs = require('fs');

async function buildMasterDb() {
  console.log("Loading databases...");
  const anibridge = JSON.parse(fs.readFileSync('anibridge.json', 'utf8'));
  const manami = JSON.parse(fs.readFileSync('manami.json', 'utf8'));

  console.log("Building Manami ID -> Titles map...");
  const manamiMap = {};
  for (const anime of manami.data) {
    const alSource = anime.sources.find(s => s.includes('anilist.co/anime/'));
    if (!alSource) continue;
    const alId = alSource.split('/anime/')[1];
    
    const malSource = anime.sources.find(s => s.includes('myanimelist.net/anime/'));
    const malId = malSource ? malSource.split('/anime/')[1] : null;
    
    const kitSource = anime.sources.find(s => s.includes('kitsu.app/anime/') || s.includes('kitsu.io/anime/'));
    const kitsuId = kitSource ? kitSource.split('/anime/')[1] : null;

    manamiMap[alId] = {
      titles: [anime.title, ...(anime.synonyms || [])].filter(Boolean),
      malId,
      kitsuId
    };
  }

  console.log("Merging AniBridge mappings...");
  const MASTER_DB = {};

  for (const [sourceKey, targets] of Object.entries(anibridge)) {
    if (sourceKey.startsWith('$') || !sourceKey.includes(':')) continue;
    
    // Parse source like "tmdb_show:95479:s1" or "tvdb_show:12345:s2"
    const sourceParts = sourceKey.split(':');
    const sourceProvider = sourceParts[0].replace('_show', '').replace('_movie', '');
    const sourceId = sourceParts[1];
    const sourceSeason = sourceParts[2] || 's1'; // Default to s1 if missing
    const normalizedSourceKey = `${sourceProvider}:${sourceId}:${sourceSeason}`;

    for (const [targetKey, rangeMap] of Object.entries(targets)) {
      if (targetKey.startsWith('$') || !targetKey.includes(':')) continue;
      
      const targetParts = targetKey.split(':');
      if (targetParts[0] !== 'anilist') continue; // Only need AniList targets
      
      const anilistId = targetParts[1];
      const manamiData = manamiMap[anilistId];
      
      if (!manamiData) continue; // Skip if Manami doesn't have titles

      if (!MASTER_DB[normalizedSourceKey]) {
        MASTER_DB[normalizedSourceKey] = [];
      }

      // Process ranges like "25-47": "1-23"
      for (const [srcRange, tgtRange] of Object.entries(rangeMap)) {
        const [srcStart, srcEnd] = srcRange.split('-').map(Number);
        
        MASTER_DB[normalizedSourceKey].push({
          srcStart,
          srcEnd,
          anilistId,
          malId: manamiData.malId,
          kitsuId: manamiData.kitsuId,
          titles: manamiData.titles
        });
      }
    }
  }

  // Sort ranges so the Netlify function can easily find the right match
  for (const key in MASTER_DB) {
    MASTER_DB[key].sort((a, b) => a.srcStart - b.srcStart);
  }

  fs.writeFileSync('master-db.json', JSON.stringify(MASTER_DB, null, 2));
  console.log(`Master DB built successfully! Total keys: ${Object.keys(MASTER_DB).length}`);
}

buildMasterDb().catch(console.error);
