import { checkTwoAddressesAndCarRoute } from './transit-time-2gis.js';

const DEFAULT_DGIS_API_KEY = 'c7331d1e-e773-42ec-9ff4-25f8626739f8';
const args = process.argv.slice(2);
const debugIndex = args.indexOf('--debug');
const debug = debugIndex !== -1;

if (debug) {
  args.splice(debugIndex, 1);
}

const [originAddress, destinationAddress] = args;

if (!originAddress || !destinationAddress) {
  console.error(
    'Usage: node run-transit.js [--debug] "origin address" "destination address"\n' +
      'Example: node run-transit.js --debug "Москва, ул. Генерала Тюленева, 9" "метро Улица 1905 года, Москва"'
  );
  process.exit(1);
}

const apiKey = process.env.DGIS_API_KEY || process.env.TWOGIS_API_KEY || DEFAULT_DGIS_API_KEY;

if (!apiKey) {
  console.error('Set DGIS_API_KEY or TWOGIS_API_KEY in your environment first.');
  process.exit(1);
}

try {
  const result = await checkTwoAddressesAndCarRoute({
    originAddress,
    destinationAddress,
    apiKey,
    debug,
    logger: (...parts) => console.log(...parts),
  });

  console.log(
    JSON.stringify(
      {
        origin: {
          query: result.origin?.query || null,
          title: result.origin?.title || null,
          exact: Boolean(result.origin?.exact),
          precision: result.origin?.precision || null,
        },
        destination: {
          query: result.destination?.query || null,
          title: result.destination?.title || null,
          exact: Boolean(result.destination?.exact),
          precision: result.destination?.precision || null,
        },
        car: result.route
          ? {
              minutes: result.route.minutes,
              seconds: result.route.seconds,
              total_duration: result.route.total_duration,
            }
          : null,
        error: result.error || null,
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = 1;
}
