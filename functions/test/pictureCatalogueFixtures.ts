/** What the catalogues answer for "Lion", by where the request went: shared by the picture search tests. */
const OPEN = (id: number) => ({
  license_code: "cc-by",
  medium_url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${id}/medium.jpg`,
  original_dimensions: { width: 1200, height: 900 },
  attribution: "(c) someone, some rights reserved (CC BY)",
});
const CLOSED = (id: number) => ({ ...OPEN(id), license_code: "cc-by-nc" });
const claim = (value: unknown) => [{ mainsnak: { datavalue: { value } } }];

export function catalogueAnswer(url: URL): unknown {
  switch (url.host) {
    case "api.themoviedb.org":
      return { results: [{ media_type: "movie", id: 8587, title: "The Lion King", poster_path: "/lion.jpg", release_date: "1994-06-15" }], total_pages: 1 };
    case "graphql.anilist.co":
      return { data: { media: { pageInfo: { hasNextPage: false }, media: [] }, characters: { characters: [] } } };
    case "id.twitch.tv":
      return { access_token: "token", expires_in: 60 * 24 * 60 * 60 };
    case "api.igdb.com":
      return [];
    case "store.steampowered.com":
      return { items: [{ type: "app", id: 10 }] };
    case "api.steampowered.com":
      return { response: { store_items: [] } };
    case "openlibrary.org":
      return { numFound: 1, docs: [{ key: "/works/OL1W", title: "Lion", cover_i: 5 }] };
    case "www.wikidata.org":
      return url.searchParams.get("action") === "wbsearchentities"
        ? { search: [{ id: "Q140" }] }
        : { entities: { Q140: { labels: { en: { value: "Lion" } }, descriptions: { en: { value: "big cat" } }, claims: { P18: claim("Lion waiting.jpg") } } } };
    case "commons.wikimedia.org":
      return { query: { pages: { "1": { title: "File:Lion waiting.jpg", imageinfo: [{ width: 1200, height: 900, extmetadata: { Artist: { value: "Someone" }, LicenseShortName: { value: "CC BY-SA 4.0" } } }] } } } };
    case "api.inaturalist.org":
      if (url.pathname === "/v1/taxa/autocomplete") {
        return {
          results: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({
            id,
            name: `Panthera ${id}`,
            preferred_common_name: `Lion ${id}`,
            default_photo: id === 1 ? OPEN(id) : CLOSED(id),
          })),
        };
      }
      if (url.pathname.startsWith("/v1/taxa/")) {
        const ids = url.pathname.slice("/v1/taxa/".length).split(",").map(Number);
        return { results: ids.map((id) => ({ id, taxon_photos: [{ photo: id <= 4 ? OPEN(100 + id) : CLOSED(100 + id) }] })) };
      }
      return { results: [{ photos: [{ ...OPEN(200), url: "https://inaturalist-open-data.s3.amazonaws.com/photos/200/square.jpg" }] }] };
    default:
      return {};
  }
}

