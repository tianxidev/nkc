const { settingIds } = require('../../settings/serverSettings');
module.exports = {
  _id: settingIds.editor,
  c: {
    notes:
      '1. 每隔60秒编辑器会自动将已输入的内容保存到草稿箱，相应的草稿会在内容发表后被清除。而未清除的草稿可以在下一次从相同入口进入编辑器时选择加载。',
    onEditNotes: '',
    notices: '',
  },
};
