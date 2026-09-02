import { initializeApp } from "firebase-admin/app";

initializeApp();

export { generate } from "./generate";
export { credits } from "./credits";
export { adoptGuestCredits } from "./adopt";
export { lists } from "./community";
export { boards } from "./boards";
export { tmdb } from "./tmdb";
// Games are written and tested but not exported: the function declares two
// Twitch secrets, and Firebase checks every function's secrets on every
// deploy, so an unset one blocks deploying anything at all. One line back
// once TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET exist.
// export { games } from "./games";
export { sweepGuests } from "./sweep";
export { sweepPictures } from "./sweepPictures";
