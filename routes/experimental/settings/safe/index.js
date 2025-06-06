const Router = require('koa-router');
const Querys = require('./query');
const SettingModel = require('../../../../dataModels/SettingModel');
const UsersPersonalModel = require('../../../../dataModels/UsersPersonalModel');
const { OnlyOperation } = require('../../../../middlewares/permission');
const { Operations } = require('../../../../settings/operations');

const router = new Router();
router
  .get(
    '/',
    OnlyOperation(Operations.experimentalSafeSettings),
    async (ctx, next) => {
      const { data, db } = ctx;
      data.safeSettings = (await db.SettingModel.findById('safe')).c;
      data.safeSettings.hasPassword =
        !!data.safeSettings.experimentalPassword.hash;
      delete data.safeSettings.experimentalPassword;
      data.weakPasswordChecking = db.WeakPasswordResultModel.isChecking();
      ctx.template = 'experimental/settings/safe/safe.pug';
      await next();
    },
  )
  .put(
    '/',
    OnlyOperation(Operations.experimentalSafeSettings),
    async (ctx, next) => {
      const { db, body, nkcModules } = ctx;
      const { safeSettings } = body;
      const { phoneVerify } = safeSettings;
      if (safeSettings.experimentalTimeout >= 5) {
      } else {
        ctx.throw(400, '后台密码过期时间不能小于5分钟');
      }
      const _ss = await db.SettingModel.getSettings('safe');
      if (
        (!_ss.experimentalPassword || !_ss.experimentalPassword.hash) &&
        safeSettings.experimentalVerifyPassword
      )
        ctx.throw(400, '请先设置后台密码');
      await db.SettingModel.updateOne(
        { _id: 'safe' },
        {
          $set: {
            'c.experimentalVerifyPassword':
              safeSettings.experimentalVerifyPassword,
            'c.experimentalTimeout': safeSettings.experimentalTimeout,
            'c.phoneVerify': {
              enable: phoneVerify.enable,
              interval: phoneVerify.interval,
            },
          },
        },
      );
      await db.SettingModel.saveSettingsToRedis('safe');
      await next();
    },
  )
  .get(
    '/unverifiedPhone',
    OnlyOperation(Operations.unverifiedPhonePage),
    async (ctx, next) => {
      ctx.template =
        'experimental/settings/safe/unverifiedPhone/unverifiedPhone.pug';
      const { data, db, nkcModules, query } = ctx;
      const { page = 0, type, content } = query;

      let result = {};
      if (!type || !content) {
        result = await Querys.queryUnverifiedPhone(page);
      } else if (type === 'username') {
        result = await Querys.queryUnverifiedPhoneByUsername(page, content);
      } else if (type === 'phone') {
        result = await Querys.queryUnverifiedPhoneByPhone(page, content);
      } else if (type === 'uid') {
        result = await Querys.queryUnverifiedPhoneByUid(page, content);
      }

      const { paging, personals } = result;
      data.paging = paging;

      const earliestDate = await Querys.getEarliestDate();
      const personalObj = personals.map((person) => {
        const { nationCode, mobile } = person;
        if (person.lastVerifyPhoneNumberTime) {
          person.timeout =
            (earliestDate - person.lastVerifyPhoneNumberTime) / 1000 / 60 / 60;
        }
        if (nationCode && mobile) {
          person.mobile = `+${nationCode} ${mobile.substring(
            0,
            3,
          )}****${mobile.substring(7)}`;
        }
        return person;
      });
      data.list = personalObj;
      return next();
    },
  )
  .post(
    '/modifyPassword',
    OnlyOperation(Operations.modifyBackendPassword),
    async (ctx, next) => {
      const { nkcModules } = ctx;
      const { oldPassword, newPassword } = ctx.body;
      const passwordObj = nkcModules.apiFunction.newPasswordObject(newPassword);
      await SettingModel.updateOne(
        { _id: 'safe' },
        {
          $set: {
            'c.experimentalPassword': {
              hash: passwordObj.password.hash,
              salt: passwordObj.password.salt,
              secret: passwordObj.secret,
            },
          },
        },
      );
      await SettingModel.saveSettingsToRedis('safe');
      return next();
    },
  )
  .get(
    '/weakPasswordCheck',
    OnlyOperation(Operations.weakPasswordCheck),
    async (ctx, next) => {
      const { db } = ctx;
      if (db.WeakPasswordResultModel.isChecking()) {
        ctx.throw(403, '检测尚未结束，请稍后直接查看结果');
      }
      db.WeakPasswordResultModel.weakPasswordCheck();
      return next();
    },
  )
  .get(
    '/weakPasswordCheck/result',
    OnlyOperation(Operations.weakPasswordCheckResult),
    async (ctx, next) => {
      ctx.template =
        'experimental/settings/safe/weakPasswordCheck/weakPasswordCheck.pug';
      const { data, db, nkcModules, query } = ctx;
      const { page = 0, type, content } = query;
      const count = await db.WeakPasswordResultModel.countDocuments();
      const paging = nkcModules.apiFunction.paging(page, count);
      data.paging = paging;
      const list = await db.WeakPasswordResultModel.find({})
        .sort({ toc: 1 })
        .skip(paging.start)
        .limit(paging.perpage);
      data.list = [];
      const usersId = list.map((l) => l.uid);
      let users = await db.UserModel.find({ uid: { $in: usersId } });
      users = await db.UserModel.extendUsersInfo(users);
      const usersObj = {};
      for (const user of users) {
        usersObj[user.uid] = user;
      }
      for (const l of list) {
        const { toc, uid, password } = l;
        const user = usersObj[uid];
        if (!user) continue;
        data.list.push({
          uid,
          toc,
          password,
          userXSF: user.xsf,
          userBanned: user.certs.includes('banned'),
          userToc: user.toc,
          userTlm: user.tlv,
          userAvatar: user.avatar,
          username: user.username,
          userCertsName: user.info.certsName,
          userGradeId: user.grade._id,
          userGradeName: user.grade.displayName,
        });
      }
      await next();
    },
  )
  .post(
    '/weakPasswordCheck/result',
    OnlyOperation(Operations.weakPasswordCheckResult),
    async (ctx, next) => {
      const { db, state } = ctx;
      const results = await db.WeakPasswordResultModel.find({}, { uid: 1 });
      const resultsUsersId = results.map((r) => r.uid);
      const users = await db.UserModel.find(
        { uid: { $in: resultsUsersId }, certs: { $ne: 'banned' } },
        { uid: 1 },
      );
      const toc = Date.now();
      const usersId = [];
      for (const user of users) {
        usersId.push(user.uid);
        await db.ManageBehaviorModel.insertLog({
          ip: ctx.address,
          port: ctx.port,
          uid: state.uid,
          toUid: user.uid,
          operationId: 'bannedUser',
          toc,
        });
      }
      if (usersId.length > 0) {
        await db.UserModel.updateMany(
          {
            uid: { $in: usersId },
          },
          {
            $addToSet: {
              certs: 'banned',
            },
          },
        );
      }
      await next();
    },
  );
module.exports = router;
