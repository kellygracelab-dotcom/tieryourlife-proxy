import { initializeApp } from "firebase-admin/app";

initializeApp();

export { generate } from "./generate";
export { credits } from "./credits";
export { adoptGuestCredits } from "./adopt";
export { lists } from "./community";
export { boards } from "./boards";
export { tmdb } from "./tmdb";
export { games } from "./games";
export { sweepGuests } from "./sweep";
export { sweepPictures } from "./sweepPictures";
