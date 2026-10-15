const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const srcDir = path.join(__dirname, '../src/frontend');
const distDir = path.join(__dirname, '../dist');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveIncludes(content) {
  // Regex matches <?!= include('Filename'); ?> or <?!= include("Filename") ?>
  const regex = /<\?!=\s*include\(['"]([^'"]+)['"]\);?\s*\?>/g;
  
  return content.replace(regex, (match, filename) => {
    // If the filename starts with 'frontend/', strip it since we are already looking in src/frontend
    const cleanFilename = filename.replace(/^frontend\//, '');
    const filePath = path.join(srcDir, `${cleanFilename}.html`);
    
    if (fs.existsSync(filePath)) {
      console.log(`Resolving include: ${filename}`);
      let fileContent = fs.readFileSync(filePath, 'utf-8');
      // Recursively resolve includes inside the included file
      return resolveIncludes(fileContent);
    } else {
      console.warn(`Warning: Could not find include file: ${filePath}`);
      return match;
    }
  });
}

function build() {
  ensureDir(distDir);
  
  console.log('Running Tailwind CSS build...');
  try {
    execSync('npx tailwindcss -i ./src/frontend/input.css -o ./dist/style.css --minify', { stdio: 'inherit' });
  } catch (error) {
    console.error('Tailwind build failed:', error);
    process.exit(1);
  }

  const indexPath = path.join(srcDir, 'Index.html');
  
  if (fs.existsSync(indexPath)) {
    console.log('Starting Cloudflare build...');
    let content = fs.readFileSync(indexPath, 'utf-8');
    
    // Resolve all includes
    let resolvedContent = resolveIncludes(content);
    
    // Strip Tailwind CDN and config, inject style.css
    resolvedContent = resolvedContent.replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/, '');
    resolvedContent = resolvedContent.replace(/<script>\s*tailwind\.config\s*=\s*\{[\s\S]*?\}?;\s*<\/script>/, '');
    resolvedContent = resolvedContent.replace('</head>', '  <link rel="stylesheet" href="style.css">\n</head>');
    
    // Write final output to dist/index.html
    const outPath = path.join(distDir, 'index.html');
    fs.writeFileSync(outPath, resolvedContent);
    
    console.log(`Build successful: dist/index.html generated.`);
  } else {
    console.error(`Error: Index.html not found in ${srcDir}.`);
    process.exit(1);
  }
}

build();
