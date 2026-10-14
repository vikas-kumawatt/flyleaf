// Beta build against the live server (docs/mobile-release.md): which API
// address each EAS build profile gets, push credentials, version scheme.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildConfig, linkHosts, resolveApiUrl } from '../../../app.config';
import { resolveApiBase, resolvePublicBase } from '../apiBase';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(new URL(p, `file://${ROOT}`), 'utf8');
const appJson = JSON.parse(read('app.json')).expo;
const eas = JSON.parse(read('eas.json'));
const SERVER = 'https://flyleaf-vk.koreacentral.cloudapp.azure.com';

/** What app.config.ts produces for a profile, as on the EAS build server. */
function onEas(profile: string, extraEnv: Record<string, string> = {}, files: string[] = []) {
  const env = { EAS_BUILD: 'true', EAS_BUILD_PROFILE: profile, ...eas.build[profile].env, ...extraEnv };
  return buildConfig(structuredClone(appJson), env, (p) => files.some((f) => p.endsWith(f)), '/project');
}

describe('API address per EAS build profile', () => {
  it('development has no address: the app follows Metro to the laptop', () => {
    assert.equal(eas.build.development.env?.FLYLEAF_API_URL, undefined);
    const cfg = buildConfig(structuredClone(appJson), {}, () => false, '/project');
    assert.equal((cfg.extra as any).apiUrl, undefined);
    assert.equal(
      resolveApiBase({ apiUrl: (cfg.extra as any).apiUrl, hostUri: '192.168.1.5:8081', isDev: true }),
      'http://192.168.1.5:3000',
    );
    assert.equal(resolveApiBase({ apiUrl: undefined, hostUri: null, isDev: true }), 'http://10.0.2.2:3000');
  });

  it('preview (the beta APK) and production point at the server', () => {
    for (const profile of ['preview', 'production']) {
      const cfg = onEas(profile, { GOOGLE_SERVICES_JSON: '/eas/tmp/google-services.json' });
      assert.equal((cfg.extra as any).apiUrl, SERVER, profile);
      // The release bundle uses it, whatever Metro's address would be.
      assert.equal(resolveApiBase({ apiUrl: (cfg.extra as any).apiUrl, hostUri: '192.168.1.5:8081', isDev: false }), SERVER);
      assert.equal(eas.build[profile].environment, profile);
    }
  });

  it('a release build without an address stops, on the build server and in the app', () => {
    assert.throws(
      () => onEas('preview', { FLYLEAF_API_URL: '', GOOGLE_SERVICES_JSON: '/x/google-services.json' }),
      /FLYLEAF_API_URL is not set for the preview profile/,
    );
    assert.throws(() => resolveApiBase({ apiUrl: '', hostUri: null, isDev: false }), /No API address/);
  });

  it('the address is an origin; http is refused for release profiles', () => {
    assert.equal(resolveApiUrl({ FLYLEAF_API_URL: ' https://example.org/ ' }), 'https://example.org');
    assert.equal(resolveApiUrl({ FLYLEAF_API_URL: 'http://192.168.1.5:3000' }), 'http://192.168.1.5:3000');
    assert.throws(() => resolveApiUrl({ FLYLEAF_API_URL: 'https://example.org/v1' }), /origin only/);
    assert.throws(() => resolveApiUrl({ FLYLEAF_API_URL: 'example.org' }), /not a URL/);
    assert.throws(() => resolveApiUrl({ FLYLEAF_API_URL: 'ftp://example.org' }), /http\(s\)/);
    assert.throws(() => resolveApiUrl({ FLYLEAF_API_URL: 'http://example.org', EAS_BUILD_PROFILE: 'preview' }), /must be https/);
  });

  it('shared links point at the server the build talks to', () => {
    assert.equal(resolvePublicBase(SERVER, 'https://flyleaf.app'), SERVER);
    assert.equal(resolvePublicBase(undefined, 'https://flyleaf.app'), 'https://flyleaf.app');
  });

  it('no server address is written in the app code', () => {
    const files = execFileSync('git', ['ls-files', 'src', 'app'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && !f.includes('__tests__/'));
    assert.ok(files.length > 100);
    for (const f of files) assert.doesNotMatch(read(f), /cloudapp\.azure\.com/, f);
  });
});

describe('push credentials (FCM V1)', () => {
  it('app.json names google-services.json, and git ignores it', () => {
    assert.equal(appJson.android.googleServicesFile, './google-services.json');
    const ignored = execFileSync('git', ['check-ignore', '-v', 'apps/mobile/google-services.json'], { cwd: `${ROOT}../..`, encoding: 'utf8' });
    assert.match(ignored, /google-services\.json/);
  });

  it('EAS file variable first, then a local file; neither drops the field (dev builds still build)', () => {
    const fromEas = onEas('preview', { GOOGLE_SERVICES_JSON: '/eas/tmp/google-services.json' }, ['google-services.json']);
    assert.equal(fromEas.android?.googleServicesFile, '/eas/tmp/google-services.json');
    const local = buildConfig(structuredClone(appJson), {}, (p) => p === '/project/google-services.json', '/project');
    assert.equal(local.android?.googleServicesFile, './google-services.json');
    const none = buildConfig(structuredClone(appJson), {}, () => false, '/project');
    assert.equal(none.android?.googleServicesFile, undefined);
    assert.ok(!('googleServicesFile' in (none.android ?? {})));
  });

  it('a preview or production build without it stops on the build server', () => {
    assert.throws(() => onEas('preview'), /google-services\.json is missing for the preview profile/);
    assert.throws(() => onEas('production'), /google-services\.json is missing/);
    // Locally (eas-cli resolving the config before upload) the secret is not readable: no error.
    assert.doesNotThrow(() => buildConfig(structuredClone(appJson), { EAS_BUILD_PROFILE: 'preview', ...eas.build.preview.env }, () => false, '/p'));
  });

  it('expo-notifications is configured with the default channel the app uses', () => {
    const plugin = appJson.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-notifications');
    assert.deepEqual(plugin?.[1], { defaultChannel: 'default' });
    assert.match(read('src/lib/push.ts'), /const CHANNEL = 'default'/);
  });
});

describe('the EAS build server can bundle the app', () => {
  it('builds the git-ignored api-client dist/ that Metro maps @flyleaf/api-client to, before bundling', () => {
    // Without it a release bundle fails: "Unable to resolve module @flyleaf/api-client".
    assert.match(read('metro.config.js'), /packages\/api-client\/dist/);
    const scripts = JSON.parse(read('package.json')).scripts;
    assert.equal(scripts['eas-build-post-install'], 'npm run build:api-client');
    assert.equal(scripts['build:api-client'], 'tsc -p ../../packages/api-client/tsconfig.json');
  });
});

describe('versions', () => {
  it('a beta versionName; versionCode is EAS remote and goes up on every beta and store build', () => {
    assert.match(appJson.version, /^\d+\.\d+\.\d+-beta\.\d+$/);
    assert.equal(eas.cli.appVersionSource, 'remote');
    assert.equal(appJson.android.versionCode, undefined, 'remote versioning ignores a local versionCode');
    assert.equal(eas.build.preview.autoIncrement, true);
    assert.equal(eas.build.production.autoIncrement, true);
    assert.equal(eas.build.development.autoIncrement, undefined);
    // Updates reach only builds of the same version (runtimeVersion policy).
    assert.deepEqual(appJson.runtimeVersion, { policy: 'appVersion' });
  });
});

describe('App Links hosts', () => {
  it('flyleaf.app and the beta server, each with the same paths; iOS names the same hosts', () => {
    const hosts = linkHosts(appJson);
    assert.deepEqual(hosts.sort(), ['flyleaf-vk.koreacentral.cloudapp.azure.com', 'flyleaf.app']);
    assert.equal(`https://${hosts[0]}`, SERVER);
    const pathsFor = (host: string) =>
      appJson.android.intentFilters
        .flatMap((f: any) => f.data)
        .filter((d: any) => d.host === host)
        .map((d: any) => d.path ?? `${d.pathPrefix}*`)
        .sort();
    assert.deepEqual(pathsFor(hosts[0]!), pathsFor(hosts[1]!));
    assert.ok(appJson.android.intentFilters.every((f: any) => f.autoVerify === true));
    assert.deepEqual(appJson.ios.associatedDomains.map((d: string) => d.replace('applinks:', '')).sort(), hosts.sort());
    const cfg = buildConfig(structuredClone(appJson), {}, () => false, '/p');
    assert.deepEqual([...(cfg.extra as any).appLinkHosts].sort(), hosts.sort());
  });
});
