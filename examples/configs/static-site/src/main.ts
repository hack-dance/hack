import { nanoid } from "nanoid";

const build = document.querySelector("#build");
if (build) {
  build.textContent = `page id ${nanoid(8)}`;
}
