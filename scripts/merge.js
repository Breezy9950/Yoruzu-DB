const fs = require('fs');

async function buildMasterDb() {
  console.log("Loading databases...");
  const anibridge = JSON.parse(fs.readFileSync('anibridge.json', 'utf8'));
  const manami = JSON.parse(fs.readFileSync('manami.json', 'utf8'));

  console.log("Extracting Titles and IDs from Manami...");
  const animeData = {};
  for (const anime of manami.data) {
    const sources = anime.sources || [];
    const alSource = sources.find(s => s.includes('anilist.co/anime/'));
    if (!alSource) continue;
    const alId = alSource.split('/anime/')[1];

    const malSource = sources.find(s => s.includes('myanimelist.net/anime/'));
    const malId = malSource ? malSource.split('/anime/')[1] : null;

    const kitSource = sources.find(s => s.includes('kitsu.app/anime/') || s.includes('kitsu.io/anime/'));
    const kitsuId = kitSource ? kitSource.split('/anime/')[1] : null;

    animeData[alId] = {
      titles: [anime.title, ...(anime.synonyms || [])].filter(Boolean),
      malId,
      kitsuId,
      format: anime.type || null,
      status: anime.status || null,
      episodes: anime.episodes || null,
      year: anime.animeSeason && anime.animeSeason.year ? anime.animeSeason.year : null,
      season: anime.animeSeason && anime.animeSeason.season ? anime.animeSeason.season : null
    };
  }

  console.log("Mapping AniBridge episode ranges...");
  const mappings = {};
  let droppedAnilist = 0;
  let skippedMalformed = 0;
  let skippedLengthMismatch = 0;
  let singleEpNormalized = 0;
  let tgtStartNonOne = 0;

  for (const [sourceKey, targets] of Object.entries(anibridge)) {
    if (sourceKey.startsWith('$') || !sourceKey.includes(':')) continue;

    const sourceParts = sourceKey.split(':');
    const sourceProvider = sourceParts[0].replace('_show', '').replace('_movie', '');
    const sourceId = sourceParts[1];
    const sourceSeason = sourceParts[2] || 's1';
    const normalizedSourceKey = `${sourceProvider}:${sourceId}:${sourceSeason}`;

    for (const [targetKey, rangeMap] of Object.entries(targets)) {
      if (targetKey.startsWith('$') || !targetKey.includes(':')) continue;

      const targetParts = targetKey.split(':');
      if (targetParts[0] !== 'anilist') continue;

      const anilistId = targetParts[1];
      if (!animeData[anilistId]) { droppedAnilist++; continue; }

      if (!mappings[normalizedSourceKey]) {
        mappings[normalizedSourceKey] = [];
      }

      for (const [srcRange, tgtRange] of Object.entries(rangeMap)) {
        const srcParts = String(srcRange).split('-');
        const tgtParts = String(tgtRange).split('-');

        const srcStart = Number(srcParts[0]);
        const srcEndRaw = srcParts.length > 1 ? Number(srcParts[1]) : srcStart;
        const tgtStart = Number(tgtParts[0]);
        const tgtEndRaw = tgtParts.length > 1 ? Number(tgtParts[1]) : tgtStart;

        if (!Number.isFinite(srcStart) || !Number.isFinite(srcEndRaw) || !Number.isFinite(tgtStart)) {
          skippedMalformed++;
          continue;
        }
        const srcEnd = srcEndRaw;

        if (srcParts.length === 1) singleEpNormalized++;
        if (tgtStart !== 1) tgtStartNonOne++;

        const srcLen = srcEnd - srcStart + 1;
        const tgtLen = Number.isFinite(tgtEndRaw) ? (tgtEndRaw - tgtStart + 1) : 1;
        if (srcLen !== tgtLen) {
          skippedLengthMismatch++;
          continue;
        }

        mappings[normalizedSourceKey].push({
          srcStart,
          srcEnd,
          tgtStart,
          anilistId
        });
      }
    }
  }

  for (const key in mappings) {
    mappings[key].sort((a, b) => a.srcStart - b.srcStart);
  }

  const finalDb = { anime: animeData, mappings };

  // --- Validation: fail the build if output looks broken ---
  const animeCount = Object.keys(animeData).length;
  const mappingCount = Object.keys(mappings).length;

  console.log("\nBuild stats:");
  console.log(`  anime entries: ${animeCount}`);
  console.log(`  mapping keys: ${mappingCount}`);
  console.log(`  dropped AniBridge targets (no Manami entry): ${droppedAnilist}`);
  console.log(`  skipped malformed ranges: ${skippedMalformed}`);
  console.log(`  skipped length-mismatch ranges: ${skippedLengthMismatch}`);
  console.log(`  single-ep ranges normalized (srcEnd=srcStart): ${singleEpNormalized}`);
  console.log(`  rules with tgtStart != 1 preserved: ${tgtStartNonOne}`);

  const MIN_ANIME = 15000;
  const MIN_MAPPINGS = 40000;
  if (animeCount < MIN_ANIME) {
    throw new Error(`VALIDATION FAILED: anime count too low (${animeCount} < ${MIN_ANIME}). Upstream format may have changed.`);
  }
  if (mappingCount < MIN_MAPPINGS) {
    throw new Error(`VALIDATION FAILED: mapping count too low (${mappingCount} < ${MIN_MAPPINGS}). Upstream format may have changed.`);
  }
  if (!animeData['199']) {
    throw new Error(`VALIDATION FAILED: sanity check failed — alId 199 (Spirited Away) missing.`);
  }

  fs.writeFileSync('master-db.json', JSON.stringify(finalDb));
  console.log(`\nMaster DB built successfully! Size: ${(fs.statSync('master-db.json').size / 1024 / 1024).toFixed(2)} MB`);
}

buildMasterDb().catch(err => {
  console.error(err);
  process.exit(1);
});
