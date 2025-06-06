const Router = require('koa-router');
const { OnlyOperation } = require('../../../../middlewares/permission');
const { Operations } = require('../../../../settings/operations');
const router = new Router();
router
  .get('/', OnlyOperation(Operations.visitKcbSettings), async (ctx, next) => {
    const { data, db } = ctx;
    data.kcbsTypes = await db.KcbsTypeModel.find();
    data.kcbSettings = (await db.SettingModel.findOnly({ _id: 'kcb' })).c;
    ctx.template = 'experimental/settings/kcb.pug';
    await next();
  })
  .put('/', OnlyOperation(Operations.modifyKcbSettings), async (ctx, next) => {
    const { db, body } = ctx;
    const { kcbsTypes, kcbSettings } = body;
    const kcbSettingsDB = await db.SettingModel.findById('kcb');
    let {
      minCount,
      maxCount,
      withdrawMin,
      withdrawMax,
      withdrawCount,
      withdrawTimeBegin,
      withdrawTimeEnd,
      withdrawStatus,
      withdrawFee,
    } = kcbSettings;
    if (minCount <= 0) ctx.throw(400, '最小值不能小于0');
    if (minCount > maxCount) ctx.throw(400, '最小值最大值设置错误');
    withdrawMin = parseInt(withdrawMin);
    withdrawMax = parseInt(withdrawMax);
    withdrawFee = Number(withdrawFee);
    withdrawCount = parseInt(withdrawCount);
    withdrawStatus = !!withdrawStatus;
    withdrawTimeBegin = parseInt(withdrawTimeBegin);
    withdrawTimeEnd = parseInt(withdrawTimeEnd);
    if (withdrawMin < 0) ctx.throw(400, '最小提现金额设置错误');
    if (withdrawMax < 0) ctx.throw(400, '最大提现金额设置错误');
    if (withdrawCount < 0) ctx.throw(400, '每天最大提现次数设置错误');
    if (withdrawTimeBegin > withdrawTimeEnd)
      ctx.throw(400, '允许提现的时间段设置错误');
    if (withdrawFee >= 1 || withdrawFee < 0)
      ctx.throw(400, '提现手续费设置错误');
    for (const type of kcbsTypes) {
      let { count, num, _id } = type;
      count = parseInt(count);
      num = parseInt(num);
      const type_ = await db.KcbsTypeModel.findOnly({ _id });
      if (count >= 0 || count === -1) {
      } else {
        ctx.throw(400, `${type_.description}的次数设置错误`);
      }
      if (count === 0 || num < 0 || num > 0) {
      } else {
        ctx.throw(400, `${type_.description}的科创币变化值设置错误`);
      }
      await type_.updateOne({ count, num });
    }
    const c = {
      minCount,
      maxCount,
      withdrawTimeEnd,
      withdrawTimeBegin,
      withdrawCount,
      withdrawMin,
      withdrawFee,
      withdrawMax,
      withdrawStatus,
      totalMoney: kcbSettingsDB.c.totalMoney,
    };
    await db.SettingModel.updateOne({ _id: 'kcb' }, { $set: { c } });
    await db.SettingModel.saveSettingsToRedis('kcb');
    await next();
  })
  .put(
    '/record',
    OnlyOperation(Operations.modifyWithdrawRecord),
    async (ctx, next) => {
      const { body, db } = ctx;
      const { kcbsRecordId, type } = body;
      const record = await db.KcbsRecordModel.findOne({
        type: 'withdraw',
        _id: kcbsRecordId,
      });
      if (!record) ctx.throw(404, '记录未找到');
      if (record.c && [true, false].includes(record.c.alipayInterface))
        ctx.throw(400, '当前记录无需人工操作');
      if (!record.verify) ctx.throw(400, '当前记录无需人工操作');
      if (type === 'success') {
        await record.updateOne({
          'c.alipayInterface': true,
        });
      } else if (type === 'fail') {
        await record.updateOne({
          'c.alipayInterface': false,
        });

        const mainScore = await db.SettingModel.getMainScore();
        const r = db.KcbsRecordModel({
          _id: await db.SettingModel.operateSystemID('kcbsRecords', 1),
          from: record.to,
          scoreType: mainScore.type,
          to: record.from,
          type: 'cancelWithdraw',
          num: record.num,
          ip: ctx.address,
        });
        await r.save();

        await db.UserModel.updateUserKcb(r.to);
      } else {
        ctx.throw(400, '未知的操作类型');
      }
      await next();
    },
  );
module.exports = router;
