import fs from 'fs'
import path from 'path'
import spawn from 'cross-spawn'
import colors from 'colors/safe.js'

const cwd = process.cwd()
const karmaConf = path.join(cwd, 'karma.conf.js')
const jestConf = path.join(cwd, 'jest.config.js')

const npmPath = process.env.npm_execpath || 'npm'
const npmPathIsJs = /\.m?js/.test(path.extname(npmPath))
const execPath = npmPathIsJs ? process.execPath : npmPath
const spawnArgs = ['exec']
if (npmPathIsJs) {
  spawnArgs.unshift(npmPath)
}

const cmd = fs.existsSync(karmaConf)
  ? ['karma', 'start']
  : fs.existsSync(jestConf)
  ? ['jest']
  : null

if (cmd) {
  spawn(execPath, [...spawnArgs, ...cmd], { stdio: 'inherit' })
} else {
  // console.log(colors.gray('no test cases'))
}
