import { loadPage, selectReport, selectFight, selectEnemy } from "./front.js";

globalThis.selectReport = selectReport;
globalThis.selectFight = selectFight;
globalThis.selectEnemy = selectEnemy;

document.addEventListener("DOMContentLoaded", function () {
  loadPage();
});
