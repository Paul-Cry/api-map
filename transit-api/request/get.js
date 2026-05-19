async function main() {
  try {
    // 1. получаем csrfToken
    const tokenResponse = await fetch(
      "https://yandex.ru/maps/api/security/csrftoken"
    );

    const tokenJson = await tokenResponse.json();

    console.log("TOKEN RESPONSE:");
    console.log(tokenJson);

    const csrfToken = tokenJson.csrfToken;

    console.log("\nCSRF TOKEN:");
    console.log(csrfToken);

    // 2. запрос маршрута
    const routeUrl =
      `https://yandex.ru/maps/api/router/buildRoute` +
      `?ajax=1` +
      `&csrfToken=${encodeURIComponent(csrfToken)}` +
      `&isIntercityRoute=false` +
      `&lang=ru` +
      `&locale=ru_RU` +
      `&regionId=213` +
      `&rll=37.561397,55.764758~37.483238,55.624815` +
      `&timeDependent[type]=departure` +
      `&type=masstransit`;

    console.log("\nREQUEST URL:");
    console.log(routeUrl);

    const routeResponse = await fetch(routeUrl, {
      headers: {
        "accept": "*/*",
        "referer": "https://yandex.ru/maps/",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36"
      }
    });

    console.log("\nROUTE STATUS:");
    console.log(routeResponse.status);

    const routeText = await routeResponse.text();

    try {
      const routeJson = JSON.parse(routeText);

      console.log("\nROUTE JSON:");
      console.log(JSON.stringify(routeJson, null, 2));

    } catch {
      console.log("\nRAW RESPONSE:");
      console.log(routeText);
    }

  } catch (err) {
    console.error(err);
  }
}

main();