import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const distDir = join(process.cwd(), "dist");
const singleDir = join(process.cwd(), "dist-single");
const htmlPath = join(distDir, "index.html");

let html = readFileSync(htmlPath, "utf8");

html = html.replace(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/g, (_match, assetPath) => {
  const script = readFileSync(join(distDir, assetPath), "utf8");
  return `<script type="module">\n${script}\n</script>`;
});

html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/g, (_match, assetPath) => {
  const style = readFileSync(join(distDir, assetPath), "utf8");
  return `<style>\n${style}\n</style>`;
});

mkdirSync(singleDir, { recursive: true });
writeFileSync(join(singleDir, "index.html"), html);

for (const asset of readdirSync(distDir, { recursive: true })) {
  if (asset === "index.html" || asset.endsWith(".js") || asset.endsWith(".css")) {
    continue;
  }

  const source = join(distDir, asset);
  if (!statSync(source).isFile()) {
    continue;
  }

  const target = join(singleDir, asset);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

console.log(`Wrote ${join("dist-single", basename(htmlPath))}`);
