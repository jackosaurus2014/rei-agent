import 'dotenv/config';
import { logger } from './lib/logger';

// Commands supported:
//   market-research
//   property-scout --cities "Phoenix,Tampa" | --auto
//   analyze --address "123 Main St, Phoenix AZ 85001" --price 450000 [--type sfr]

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case 'market-research': {
      const { runMarketResearch } = await import('./agents/market-research/market-research-agent');
      await runMarketResearch();
      break;
    }

    case 'property-scout': {
      const citiesArg = getFlag(args, '--cities');
      const auto = args.includes('--auto');
      if (!citiesArg && !auto) {
        logger.error('property-scout requires --cities "City TN,City2 IN" or --auto');
        process.exit(1);
      }
      const cities = citiesArg ? parseCities(citiesArg) : [];
      const maxPrice = Number(getFlag(args, '--max-price') ?? 400000);
      const minPrice = Number(getFlag(args, '--min-price') ?? 50000);
      const scoutType = getFlag(args, '--type') ?? 'sfr';
      const { runPropertyScout } = await import('./agents/property-scout/property-scout-agent');
      await runPropertyScout({ cities, auto, maxPrice, minPrice, propertyType: scoutType });
      break;
    }

    case 'analyze': {
      const address = getFlag(args, '--address');
      const priceStr = getFlag(args, '--price');
      if (!address || !priceStr) {
        logger.error('analyze requires --address "..." and --price 450000');
        process.exit(1);
      }
      const price = Number(priceStr);
      if (isNaN(price) || price <= 0) {
        logger.error('--price must be a positive number');
        process.exit(1);
      }
      const type = (getFlag(args, '--type') ?? 'sfr') as 'sfr' | 'multifamily' | 'condo';
      const { runDealAnalyzer } = await import('./agents/deal-analyzer/deal-analyzer-manager');
      await runDealAnalyzer({ address, purchasePrice: price, propertyType: type });
      break;
    }

    default:
      logger.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// Parse city list, handling both "Memphis TN,Indianapolis IN" and "Columbus, OH,Indianapolis, IN"
function parseCities(citiesArg: string): string[] {
  const parts = citiesArg.split(',');
  const cities: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i].trim();
    // If the next segment is just a 2-letter state abbreviation, it belongs to this city
    if (i + 1 < parts.length && /^\s*[A-Z]{2}\s*$/.test(parts[i + 1])) {
      cities.push(`${part}, ${parts[i + 1].trim()}`);
      i += 2;
    } else if (part) {
      cities.push(part);
      i++;
    } else {
      i++;
    }
  }
  return cities;
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function printUsage() {
  process.stdout.write(`
REI Agent System — Usage

  npx tsx src/index.ts market-research
    Researches and ranks the top 25 US cities for SFR/multifamily investment.

  npx tsx src/index.ts property-scout --cities "Memphis TN,Indianapolis IN"
    Finds investment properties in the specified cities.
    Options: --auto (use top cities from latest market-research output)
             --max-price 300000  (default: 400000)
             --min-price 75000   (default: 50000)
             --type sfr|multifamily (default: sfr)

  npx tsx src/index.ts analyze --address "123 Main St, Phoenix AZ 85001" --price 450000
    Runs full deal analysis on a specific property address.
    Optional: --type sfr|multifamily|condo (default: sfr)

Output files are saved to ./output/ as markdown files.
`);
}

main().catch(err => {
  logger.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
