#!/usr/bin/env python3
import pathlib,sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent/'libexec'))
from manage import main
if __name__=='__main__':
 sys.argv.insert(1,'install')
 try:main()
 except Exception as e:raise SystemExit(str(e))
