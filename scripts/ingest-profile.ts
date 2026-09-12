/**
 * Ingest profile sources from the command line (section 10.1).
 *
 * `pnpm ingest-profile` runs the full pipeline over every source it can read
 * and prints the resulting draft and diff. Like the API route, it writes a
 * DRAFT and never activates it — activation happens on /profile after the diff
 * is reviewed (section 10.4 rule 4).
 *
 * `pnpm ingest-profile -- --sources github,notes --force`
 */

import './env';

import { config } from '@/lib/config';
import { PROFILE_PIPELINE_SOURCES, runProfilePipeline, type ProfilePipelineSource } from '@/lib/profile/pipeline';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const sourcesArg = argValue('--sources');
  const sources = (
    sourcesArg ? sourcesArg.split(',').map((s) => s.trim()) : [...PROFILE_PIPELINE_SOURCES]
  ).filter((source): source is ProfilePipelineSource =>
    (PROFILE_PIPELINE_SOURCES as readonly string[]).includes(source),
  );

  if (sources.length === 0) {
    console.error(`ingest-profile: no valid sources. Choose from: ${PROFILE_PIPELINE_SOURCES.join(', ')}`);
    process.exit(1);
  }

  console.log(`ingest-profile: sources = ${sources.join(', ')}`);

  const result = await runProfilePipeline({
    sources,
    userId: config.APP_USER_ID,
    options: {
      force: process.argv.includes('--force'),
      localPaths: argValue('--paths')?.split(',').map((p) => p.trim()).filter(Boolean),
    },
  });

  console.log('');
  console.log(`Draft:  ${result.draftId} (version ${result.version})`);
  console.log(`Items:  ${result.itemCount}`);
  console.log(
    `Diff:   +${result.diff.added.length} added, ~${result.diff.changed.length} changed, ` +
      `-${result.diff.removed.length} removed, ${result.diff.preserved} preserved`,
  );
  if (result.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }
  console.log('');
  console.log('Review it on /profile, then press Apply to activate this draft.');
}

main().catch((err) => {
  console.error(`ingest-profile: FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
