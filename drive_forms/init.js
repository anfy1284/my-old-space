// Application level initialization. During system startup we attempt to call
// `init.js` from each app declared in apps.json (project overrides package/framework).
const fs = require('fs');
const path = require('path');
const globalRoot = require('../drive_root/globalServerContext');

async function runAppInits() {
	try {
		const localAppsPath = path.join(__dirname, 'apps.json');
		const packageAppsPath = path.join(__dirname, '..', 'apps.json');
		const projectAppsPath = path.resolve(process.cwd(), 'apps.json');

		const configs = [];
		if (fs.existsSync(localAppsPath)) configs.push({ cfg: JSON.parse(fs.readFileSync(localAppsPath, 'utf8')), baseDir: path.resolve(__dirname, '..') });
		if (fs.existsSync(packageAppsPath)) configs.push({ cfg: JSON.parse(fs.readFileSync(packageAppsPath, 'utf8')), baseDir: path.resolve(__dirname, '..') });
		if (fs.existsSync(projectAppsPath)) configs.push({ cfg: JSON.parse(fs.readFileSync(projectAppsPath, 'utf8')), baseDir: process.cwd() });

		if (configs.length === 0) return;

		// Merge apps, project overrides package/local
		const appsMap = new Map();
		let chosenPath = '/apps';
		for (const entry of configs) {
			const cfg = entry.cfg || {};
			const appsPath = (cfg.path || '/apps').replace(/^[/\\]+/, '');
			if (cfg.path) chosenPath = cfg.path;
			const apps = cfg.apps || [];
			for (const app of apps) {
				appsMap.set(app.name, Object.assign({}, app));
			}
		}
		const apps = Array.from(appsMap.values());
		const appsBasePath = chosenPath.replace(/^[/\\]+/, '');

		for (const app of apps) {
			const projectInit = path.join(process.cwd(), appsBasePath, app.name, 'init.js');
			const packageInit = path.join(__dirname, '..', appsBasePath, app.name, 'init.js');
			let initPath = null;
			if (fs.existsSync(projectInit)) initPath = projectInit;
			else if (fs.existsSync(packageInit)) initPath = packageInit;

			if (!initPath) continue;

			try {
				// Clear require cache to ensure fresh load
				delete require.cache[require.resolve(initPath)];
				const mod = require(initPath);
				if (typeof mod === 'function') {
					// call asynchronously and don't block startup for too long
					try {
						await Promise.resolve(mod(globalRoot && globalRoot.modelsDB ? globalRoot.modelsDB : undefined));
						console.log(`[drive_forms/init] App init executed: ${app.name}`);
					} catch (e) {
						console.error(`[drive_forms/init] App init failed for ${app.name}:`, e && e.message ? e.message : e);
					}
				}
			} catch (e) {
				console.error('[drive_forms/init] Error loading app init:', initPath, e && e.message ? e.message : e);
			}
		}
	} catch (e) {
		console.error('[drive_forms/init] Error during apps init:', e && e.message ? e.message : e);
	}
}

// Run in background (caller may `require` this module at startup).
runAppInits().catch(e => console.error('[drive_forms/init] runAppInits error', e));
