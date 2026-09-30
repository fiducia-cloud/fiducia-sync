#!/usr/bin/env python3
from dataclasses import dataclass
from collections import deque

@dataclass(frozen=True)
class S:
    applied:int=0; sequence:int=0

def apply(s,eid,seq):
    bit=1<<eid
    if s.applied & bit: return s
    return S(s.applied|bit, max(s.sequence,seq))

def main():
    events=[(0,1),(1,2),(0,1)]
    q=deque([S()]); seen={S()}; edges=0
    while q:
        s=q.popleft()
        for eid,seq in events:
            n=apply(s,eid,seq); edges+=1
            assert n.sequence>=s.sequence, 'sequence regressed'
            assert (n.applied|s.applied)==n.applied, 'applied set regressed'
            if n not in seen: seen.add(n); q.append(n)
    assert apply(S(1,1),0,1)==S(1,1), 'duplicate replay not idempotent'
    print(f'replay sequence model: {len(seen)} states, {edges} transitions')
if __name__=='__main__': main()
