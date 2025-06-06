const router = require('koa-router')();
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const StreamZip = require('node-stream-zip');
const { Public, OnlyOperation } = require('../../middlewares/permission');
const { Operations } = require('../../settings/operations');
router
  // 工具列表
  .get('/', Public(), async (ctx, next) => {
    const { data, db } = ctx;
    const toolsSettings = await db.SettingModel.getSettings('tools');
    if (!toolsSettings.enabled && !ctx.permission(Operations.enableSiteTools)) {
      ctx.throw(403, '权限不足');
    }
    let toolsModel = db.ToolsModel;
    data.list = await toolsModel
      .find({
        isHide: false,
      })
      .sort({ order: 1 });
    ctx.template = 'tools/list.pug';
    await next();
  })

  // 打开工具
  .get('/open/:toolid', Public(), async (ctx, next) => {
    const { data, db, params } = ctx;
    const toolsSettings = await db.SettingModel.getSettings('tools');
    if (!toolsSettings.enabled && !ctx.permission(Operations.enableSiteTools)) {
      ctx.throw(403, '权限不足');
    }
    let toolsModel = db.ToolsModel;
    let toolInfo = await toolsModel.findOne({ _id: params.toolid });
    // console.log(toolInfo);
    if (!toolInfo) {
      ctx.throw(400, `未找到ID为${params.toolid}的工具`);
    }
    if (toolInfo.isHide && !ctx.permission(Operations.hideTool)) {
      ctx.throw(403, '权限不足');
    }
    data.toolInfo = toolInfo.toObject();
    ctx.template = 'tools/container.pug';
    await next();
  })

  // 上传和更新工具接口(压缩包 .zip)
  .post('/update', OnlyOperation(Operations.updateTool), async (ctx, next) => {
    const { db, body } = ctx;
    const { toolsPath } = ctx.settings.upload;
    const { fields, files } = body;
    const { file } = files;
    let completePath;
    // 检查和补全工具信息
    let { info, err } = checkToolInfo(fields);
    if (err) {
      ctx.throw(400, err);
    }
    if (!fields._id) {
      ctx.throw(400, '缺少参数 _id');
    }
    const toolData = await db.ToolsModel.findOnly({ _id: fields._id });
    const filePath = toolsPath + `/${toolData._id}`;
    if (file) {
      if (!isZipFile(file)) {
        ctx.throw(400, '文件必须是一个压缩包');
      }
      // 处理压缩包(如果有)
      try {
        // 解压完成之后的路径(还在tmp下)
        completePath = await zipExtractToDir(file.path, path.resolve('./tmp'));
      } catch (error) {
        ctx.throw(500, error);
      }
      // console.log(completePath);
      const entryFile = `index.html`; // 入口文件名
      const entryFilePath = findFileInRoot(completePath, entryFile);
      if (!entryFilePath) {
        if (completePath) {
          await deleteFolder(completePath);
        }
        ctx.throw(400, `未找到入口文件: ${entryFile}`);
      }
    }
    // 更新工具信息
    await toolData.updateOne(info);
    // 把解压好的文件夹移动到最终位置(如果有)
    if (completePath) {
      await deleteFolder(filePath);
      await moveDir(completePath, filePath);
    }
    await next();
  })
  // 删除工具
  .del('/delete', OnlyOperation(Operations.deleteTool), async (ctx, next) => {
    const { db, query } = ctx;
    let id = query._id;
    if (!id) {
      ctx.throw(400, '缺少参数 _id');
    }
    const toolData = await db.ToolsModel.findOne({ _id: id });
    if (toolData) {
      await db.ToolsModel.where({ _id: id }).deleteOne();
      const { toolsPath } = ctx.settings.upload;
      await deleteFolder(toolsPath + `/${toolData._id}`);
    }
    await next();
  })
  // 上传工具
  .post('/upload', OnlyOperation(Operations.uploadTool), async (ctx, next) => {
    const { db, body } = ctx;
    const { fields, files } = body;
    const { file } = files;
    let completePath;
    // 检查和补全工具信息
    let { info, err } = checkToolInfo(fields);
    if (err) {
      ctx.throw(400, err);
    }
    const { toolsPath } = ctx.settings.upload;
    if (!info.isOtherSite) {
      if (!file) {
        ctx.throw(400, '缺少压缩包');
      }
      if (!isZipFile(file)) {
        ctx.throw(400, '文件必须是一个压缩包');
      }
      // 解压文件
      try {
        // 解压完成之后的路径(还在tmp下)
        completePath = await zipExtractToDir(file.path, path.resolve('./tmp'));
      } catch (error) {
        ctx.throw(500, error);
      }
      // console.log(completePath);
      const entryFile = `index.html`; // 入口文件名
      const entryFilePath = findFileInRoot(completePath, entryFile);
      if (!entryFilePath) {
        if (completePath) {
          await deleteFolder(completePath);
        }
        ctx.throw(400, `未找到入口文件: ${entryFile}`);
      }
    }
    // 信息入库
    const toolsModel = db.ToolsModel;
    const settingModel = db.SettingModel;
    const toolsCount = await db.ToolsModel.countDocuments();
    let id = await settingModel.operateSystemID('tools', 1);
    const filePath = toolsPath + `/${id}`;
    let doc = toolsModel({ ...info, _id: id, order: toolsCount });
    await doc.save();
    // 移动文件到最终位置
    if (completePath) {
      await deleteFolder(filePath);
      await moveDir(completePath, filePath);
    }
    await next();
  })
  // 屏蔽工具
  .del('/hide', OnlyOperation(Operations.hideTool), async (ctx, next) => {
    const { db, query } = ctx;
    let id = query._id;
    if (!id) {
      ctx.throw(400, '缺少参数 _id');
    }
    let toolsModel = db.ToolsModel;
    let result = await toolsModel.findOne({ _id: id });
    let toolinfo = result.toObject();
    let isHide = toolinfo.isHide;
    await toolsModel.where({ _id: id }).updateOne({ isHide: !isHide });
    await next();
  })
  // 网站工具的启用和禁用
  .post(
    '/enableSiteTools',
    OnlyOperation(Operations.enableSiteTools),
    async (ctx, next) => {
      let { data, db } = ctx;
      let { SettingModel } = db;
      const toolSettings = await SettingModel.getSettings('tools');
      let updatedStatu = !toolSettings.enabled;
      await SettingModel.updateOne(
        { _id: 'tools' },
        {
          $set: {
            'c.enabled': updatedStatu,
          },
        },
      );
      await SettingModel.saveSettingsToRedis('tools');
      data.enabled = updatedStatu;
      data.message = updatedStatu ? '已启用网站工具' : '已禁用网站工具';
      return next();
    },
  )
  .post(
    '/order',
    OnlyOperation(Operations.modifyToolsOrder),
    async (ctx, next) => {
      const { body, db } = ctx;
      const { toolsId } = body;

      // 获取所有工具的 _id
      const tools = await db.ToolsModel.find({}, { _id: 1 });

      // 构建批量更新操作
      const bulkOps = tools.map((tool) => {
        const index = toolsId.indexOf(tool._id);
        return {
          updateOne: {
            filter: { _id: tool._id },
            update: { $set: { order: index } },
          },
        };
      });

      // 执行批量更新
      await db.ToolsModel.bulkWrite(bulkOps);

      await next();
    },
  );

// 判断是否是zip压缩文件
function isZipFile(file) {
  if (!file.path || !file.name || !file.type) {
    return false;
  }
  return file.name.endsWith('.zip');
}

// 解压zip文件到指定目录
function zipExtractToDir(zipFilePath, targetPath) {
  return new Promise((resolve, reject) => {
    const zip = new StreamZip({
      file: zipFilePath,
      storeEntries: true,
    });
    zip.on('ready', () => {
      if (zip.entriesCount < 2) {
        reject('压缩文件中请至少包含一个文件');
      }
      let outsideDir = Object.values(zip.entries())[0];
      if (!outsideDir.isDirectory) {
        reject('格式错误，请使用只包含一个文件夹的压缩包');
      }
      zip.extract(null, targetPath, (err) => {
        if (err) {
          return reject(err);
        }
        zip.close();
        resolve(path.resolve(targetPath + '/' + outsideDir.name));
      });
    });
  });
}

// 检查和补全用户提交的工具信息
function checkToolInfo(data) {
  let res = Object.create(null);
  if (!data.name) {
    res.err = '工具名不能为空';
    return res;
  }
  // if (!data.entry) {
  //   data.entry = '/index.html';
  // }
  if (!data.version) {
    data.version = '1.0';
  }
  if (data.isOtherSite === 'true') {
    data.isOtherSite = true;
  }
  if (data.isOtherSite === 'false') {
    data.isOtherSite = false;
  }
  if (!data.isOtherSite) {
    data.isOtherSite = false;
  }
  res.info = {
    version: data.version,
    name: data.name,
    summary: data.summary,
    author: data.author,
    uid: data.uid,
    entry: data.isOtherSite ? data.entry : '/index.html',
    isOtherSite: data.isOtherSite,
    lastModify: Date.now(),
  };
  return res;
}

// 移动文件夹到新目录
async function moveDir(sourcePath, toPath) {
  await deleteFolder(toPath); // 保证目标路径不存在同名文件夹
  await fsPromises.rename(sourcePath, toPath);
}

// 删除文件夹
async function deleteFolder(path) {
  let files = [];
  if (fs.existsSync(path)) {
    files = await fsPromises.readdir(path);
    await Promise.all(
      files.map(async (file) => {
        const curPath = path + '/' + file;
        if ((await fsPromises.stat(curPath)).isDirectory()) {
          // recurse
          await deleteFolder(curPath);
        } else {
          // delete file
          await fsPromises.unlink(curPath);
        }
      }),
    );
    await fsPromises.rmdir(path);
  }
}

/**
 * 查找压缩包根目录中的目标文件
 * @param {string} dir - 解压后的根目录
 * @param {string} targetFile - 要查找的文件名（如 index.html）
 * @returns {string|null} - 返回目标文件的路径，未找到时返回 null
 */
function findFileInRoot(dir, targetFile) {
  const files = fs.readdirSync(dir); // 读取目录中的文件和文件夹
  for (const file of files) {
    const fullPath = path.join(dir, file); // 获取完整路径
    const stat = fs.statSync(fullPath);

    if (stat.isFile() && file === targetFile) {
      return fullPath; // 返回完整路径
    }
  }
  return null; // 未找到目标文件
}
module.exports = router;
