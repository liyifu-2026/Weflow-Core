import assert from 'node:assert/strict'
import test from 'node:test'

import { agentDisplayName, contactDisplayName } from '../labels.ts'

test('agentDisplayName prefers displayName then username then fallback', () => {
  assert.equal(
    agentDisplayName({ displayName: '小明', username: 'op_xiaoming' }),
    '小明',
  )
  assert.equal(
    agentDisplayName({ displayName: null, username: 'op_xiaoming' }),
    'op_xiaoming',
  )
  assert.equal(
    agentDisplayName({ displayName: '', username: 'op_xiaoming' }),
    'op_xiaoming',
  )
  assert.equal(agentDisplayName(undefined), '值班操作员')
})

test('contactDisplayName follows the shared display-name chain', () => {
  assert.equal(
    contactDisplayName({
      contact: { sharedAlias: '客户A', channelDisplayName: '客户B' },
    }),
    '客户A',
  )
  assert.equal(
    contactDisplayName({ contact: { channelNickname: '昵称' } }),
    '昵称',
  )
  assert.equal(contactDisplayName({ contact: {} }), '未知联系人')
})
