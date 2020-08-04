import * as path from 'path';
import * as fse from 'fs-extra';
import * as chalk from 'chalk';
import * as urlJoin from 'url-join';
import axios from 'axios';
import getNpmRegistry from '../../utils/getNpmRegistry';
import getUnpkgHost from '../../utils/getUnpkgHost';
import log from '../../utils/log';

export default async function generateMaterialData(pkgPath, materialType, materialConfig) {
  const projectPath = path.dirname(pkgPath);
  const pkg = await fse.readJson(pkgPath);

  const materialItemConfig = pkg[`${materialType}Config`] || {};
  const { name: npmName, version } = pkg;
  const unpkgHost = await getUnpkgHost(npmName, materialConfig);
  // 默认情况不能用 taobao 源，因为存在不同步问题
  const registry = await getNpmRegistry(npmName, materialConfig, pkg.publishConfig, false);

  // 检查包是否发布并补全时间
  // log.verbose('getNpmPublishTime start', npmName, version, registry);
  const { created: publishTime, modified: updateTime } = await getNpmPublishTime(npmName, version, registry);
  // log.verbose('getNpmPublishTime success', npmName, version);

  const screenshot = materialItemConfig.screenshot
    || materialItemConfig.snapshot
    || (fse.existsSync(path.join(projectPath, 'screenshot.png')) && `${unpkgHost}/${npmName}@${pkg.version}/screenshot.png`)
    || (fse.existsSync(path.join(projectPath, 'screenshot.jpg')) && `${unpkgHost}/${npmName}@${pkg.version}/screenshot.jpg`)
    || '';
  const screenshots = materialItemConfig.screenshots || (screenshot && [screenshot]);
  const homepage = pkg.homepage || `${unpkgHost}/${npmName}@${pkg.version}/build/index.html`;

  const {categories: originCategories, category: originCategory} = materialItemConfig;
  // categories 字段：即将废弃，但是展示端还依赖该字段，因此短期内不能删除，同时需要兼容新的物料无 categories 字段
  const categories = originCategories || (originCategory ? [originCategory] : []);
  // category 字段：兼容老的物料无 category 字段
  const category = originCategory || ((originCategories && originCategories[0]) ? originCategories[0] : '');

  let languageType = 'js';
  try {
    languageType = await getProjectLanguageType(projectPath, pkg);
  } catch (err) {
    log.warn('getProjectLanguageType warning', err.message);
  }

  const materialData = {
    // 允许（但不推荐）自定义单个物料的数据
    ...materialItemConfig,
    name: materialItemConfig.name,
    title: materialItemConfig.title,
    description: pkg.description,
    languageType,
    homepage,
    categories,
    category,
    repository: (pkg.repository && pkg.repository.url) || pkg.repository,
    source: {
      type: 'npm',
      npm: npmName,
      version: pkg.version,
      registry,
      author: pkg.author,
    },
    dependencies: pkg.dependencies || {},
    screenshot,
    screenshots,
    publishTime,
    updateTime,
  };

  if (materialItemConfig === 'block') {
    // iceworks 2.x 依赖该字段，下个版本删除
    materialData.source.sourceCodeDirectory = 'src/';
  }

  return { materialData, materialType };
};

/**
 * 检测 NPM 包是否已发送，并返回包的发布时间
 *
 * @param  {string} npm      package name
 * @param  {String} version  pacage version
 * @return {array} [code, resute]
 */
function getNpmPublishTime(npm, version = 'latest', registry) {
  const url = urlJoin(registry, npm);
  log.verbose('getNpmPublishTime', url);
  return axios.get(url)
    .then((response) => {
      const { data } = response;
      if (!data.time) {
        console.error(chalk.red('time 字段不存在'));
        return Promise.reject(new Error(`${npm}@${version} time 字段不存在`));
      }
      // 传进来的可能是 latest 这种非 数字型的 版本号
      const distTags = data['dist-tags'];
      version = distTags[version] || version;
      const { versions } = data;

      log.verbose('Generate:', url, version, 'distTags', distTags, 'versions', versions ? Object.keys(versions) : '[]');

      if (!versions || versions[version] === undefined) {
        return Promise.reject(new Error(`${npm}@${version} 未发布! 禁止提交!`));
      }
      return data.time;
    })
    .catch((err) => {
      if (
        (err.response && err.response.status === 404)
        || err.message === 'Not found' // tnpm
        || /not found/i.test(err.message) // tnpm
        || err.message === 'not_found' // npm
      ) {
        // 这种情况是该 npm 包名一次都没有发布过
        return Promise.reject(new Error(`[ERR checkAndQueryNpmTime] ${npm}@${version} hasn't been published! please publish npm first!`));
      }

      return Promise.reject(err);
    });
}
async function getProjectLanguageType(projectPath, pkgData) {
  const hasTsconfig = fse.existsSync(path.join(projectPath, 'tsconfig.json'));

  if (!hasTsconfig) {
    return 'js';
  } else {
    const { dependencies = {}, devDependencies = {} } = pkgData;
    const isIcejs = devDependencies['ice.js'] || dependencies['ice.js'];
    const isRaxjs = devDependencies['rax.js'] || dependencies['rax.js'];

    if (isIcejs || isRaxjs) {
      // icejs&raxjs 都有 tsconfig，因此需要通过 src/app.js[x] 进一步区分
      const hasAppJs = fse.existsSync(path.join(projectPath, 'src/app.js')) || fse.existsSync(path.join(projectPath, 'src/app.jsx'));
      if (hasAppJs) {
        return 'js';
      }
    }

    return 'ts';
  }
}
