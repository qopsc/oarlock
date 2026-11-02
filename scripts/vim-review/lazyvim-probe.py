import os, pty, subprocess, tempfile, time, select, json, base64, signal
from pathlib import Path
import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--plugins',type=Path,default=Path.home()/'.local/share/nvim/lazy')
plugins=parser.parse_args().plugins.resolve()
with tempfile.TemporaryDirectory(prefix='oarlock-lazyvim-') as td:
    root=Path(td); target=root/'sample.txt'; ready=root/'ready.json'; picker_ready=root/'picker.json'; init=root/'init.lua'
    init.write_text('''vim.g.mapleader = ' '
vim.g.maplocalleader = '\\\\'
vim.g.lazyvim_check_order = false
vim.opt.rtp:prepend(%s)
require('lazy').setup({
 root=%s,lockfile=%s,
 spec={{'LazyVim/LazyVim', import='lazyvim.plugins'}, {'nvim-treesitter/nvim-treesitter',opts=function(_,opts) opts.ensure_installed={} opts.auto_install=false end}},
 install={missing=false}, checker={enabled=false}, change_detection={enabled=false},
 rocks={enabled=false},
})
vim.api.nvim_create_autocmd('VimEnter',{once=true,callback=function()
 vim.defer_fn(function()
  vim.fn.writefile({vim.json.encode({version=require('lazyvim.config').version,error=vim.v.errmsg})},%s)
  vim.defer_fn(function()
    local ok,pickers=pcall(function() return Snacks.picker.get() end)
    vim.fn.writefile({vim.json.encode({active=ok and #pickers > 0 or false,error=vim.v.errmsg})},%s)
  end,1500)
 end,1000)
end})
''' % tuple(json.dumps(str(p)) for p in [plugins/'lazy.nvim',plugins,root/'lazy-lock.json',ready,picker_ready]))
    env=dict(os.environ, TERM='xterm-256color')
    for kind in ['CONFIG','DATA','STATE','CACHE']:env['XDG_'+kind+'_HOME']=str(root/kind.lower())
    master,slave=pty.openpty();child=subprocess.Popen(['nvim','-u',str(init),'-i','NONE','-n',str(target)],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True,cwd=root)
    os.close(slave);transcript=bytearray();start=time.monotonic();sent=False; edited=False
    bridge=subprocess.Popen(['bun','--tsconfig-override','tsconfig.json',str(Path(__file__).with_name('terminal-bridge.ts'))],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    bridge_buffer=b''
    try:
        while time.monotonic()-start<20 and child.poll() is None:
            readable=select.select([master,bridge.stdout],[],[],0.05)[0]
            if master in readable:
                try:
                    chunk=os.read(master,65536);transcript.extend(chunk)
                    bridge.stdin.write((json.dumps({'bytes':base64.b64encode(chunk).decode()})+'\n').encode());bridge.stdin.flush()
                except OSError:break
            if bridge.stdout in readable:
                bridge_buffer+=os.read(bridge.stdout.fileno(),65536)
                while b'\n' in bridge_buffer:
                    line,bridge_buffer=bridge_buffer.split(b'\n',1)
                    os.write(master,base64.b64decode(json.loads(line)['bytes']))
            if not sent and ready.exists():
                print('LazyVim startup:',ready.read_text().strip(),flush=True)
                bridge.stdin.write((json.dumps({'keys':' ff'})+'\n').encode());bridge.stdin.flush();sent=True
            if not edited and picker_ready.exists():
                picker=json.loads(picker_ready.read_text());print('LazyVim file picker:',picker,flush=True)
                assert picker['active'], 'LazyVim leader-ff did not open a picker'
                bridge.stdin.write((json.dumps({'keys':'\x1b\x1bihello world\x1b0wciwLazyVim\x1b:%s/hello/Hello/g\n:wq\n'})+'\n').encode());bridge.stdin.flush();edited=True
        assert child.poll()==0, f'Neovim did not finish: {child.poll()}'
        assert target.read_text()=='Hello LazyVim\n',repr(target.read_text())
        print('PASS: installed LazyVim, isolated config/state/cache, no plugin installs or updates; production model and keyboard encoder: leader-ff picker, insert, Escape, motions, ciw, :%s, :wq')
    finally:
        if child.poll() is None:os.killpg(child.pid,signal.SIGKILL)
        child.wait();bridge.stdin.close();bridge.wait(timeout=3);print('Bridge diagnostics:',bridge.stderr.read().decode());os.close(master);Path('/tmp/oarlock-review102-lazyvim-pty.log').write_bytes(transcript)
