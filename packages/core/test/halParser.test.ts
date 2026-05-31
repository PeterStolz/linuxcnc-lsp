import { describe, it, expect } from 'vitest';
import { parseHal } from '../src/hal/parser';
import { collectIniRefs, LoadrtStatement, NetStatement, SetpStatement } from '../src/hal/ast';

describe('HAL parser', () => {
  it('parses loadrt with component, modparams and names', () => {
    const { statements } = parseHal('loadrt pid names=pid.x,pid.x2,pid.y');
    expect(statements.length).toBe(1);
    const s = statements[0] as LoadrtStatement;
    expect(s.kind).toBe('loadrt');
    expect(s.componentToken?.text).toBe('pid');
    expect(s.names).toEqual(['pid.x', 'pid.x2', 'pid.y']);
  });

  it('parses loadrt with count', () => {
    const s = parseHal('loadrt and2 count=2').statements[0] as LoadrtStatement;
    expect(s.componentToken?.text).toBe('and2');
    expect(s.count).toBe(2);
  });

  it('treats an IniRef as the component name', () => {
    const s = parseHal('loadrt [KINS]KINEMATICS').statements[0] as LoadrtStatement;
    expect(s.componentToken?.kind).toBe('iniref');
    expect(s.componentToken?.ini).toMatchObject({ section: 'KINS', key: 'KINEMATICS' });
  });

  it('collects all INI refs from a loadrt with INI-valued modparams', () => {
    const text =
      'loadrt [EMCMOT]EMCMOT base_period_nsec=[EMCMOT]BASE_PERIOD num_joints=[KINS]JOINTS';
    const s = parseHal(text).statements[0] as LoadrtStatement;
    const refs = collectIniRefs(s).map((t) => `${t.ini!.section}.${t.ini!.key}`).sort();
    expect(refs).toEqual(['EMCMOT.BASE_PERIOD', 'EMCMOT.EMCMOT', 'KINS.JOINTS']);
  });

  it('captures the Mesa config string', () => {
    const s = parseHal('loadrt hm2_eth board_ip="10.0.0.1" config="num_stepgens=4"')
      .statements[0] as LoadrtStatement;
    expect(s.configToken?.text).toBe('"num_stepgens=4"');
  });

  it('parses a net statement with direction arrows', () => {
    const s = parseHal('net Xpos joint.0.motor-pos-cmd => joint.0.motor-pos-fb ddt_x.in')
      .statements[0] as NetStatement;
    expect(s.signalToken?.text).toBe('Xpos');
    expect(s.links.map((l) => l.pinToken.text)).toEqual([
      'joint.0.motor-pos-cmd', 'joint.0.motor-pos-fb', 'ddt_x.in',
    ]);
    // An arrow applies only to the pin it immediately precedes.
    expect(s.links[0].arrow).toBeUndefined();
    expect(s.links[1].arrow).toBe('=>');
    expect(s.links[2].arrow).toBeUndefined();
  });

  it('parses the bidirectional <=> arrow', () => {
    const s = parseHal('net idx motenc.0.index <=> joint.0.index-enable').statements[0] as NetStatement;
    expect(s.links.map((l) => l.pinToken.text)).toEqual(['motenc.0.index', 'joint.0.index-enable']);
    expect(s.links[1].arrow).toBe('<=>');
  });

  it('parses net with a leading <= arrow', () => {
    const s = parseHal('net Xacc <= ddt_xv.out').statements[0] as NetStatement;
    expect(s.links[0]).toMatchObject({ arrow: '<=' });
    expect(s.links[0].pinToken.text).toBe('ddt_xv.out');
  });

  it('parses setp with an INI-ref value', () => {
    const s = parseHal('setp pid.x.Pgain [JOINT_0]P').statements[0] as SetpStatement;
    expect(s.pinToken?.text).toBe('pid.x.Pgain');
    expect(s.valueToken?.ini).toMatchObject({ section: 'JOINT_0', key: 'P' });
  });

  it('parses addf', () => {
    const s = parseHal('addf motion-controller servo-thread').statements[0];
    expect(s.kind).toBe('addf');
    expect((s as any).functionToken.text).toBe('motion-controller');
    expect((s as any).threadToken.text).toBe('servo-thread');
  });

  it('parses linkps pin => signal', () => {
    const s: any = parseHal('linkps parport.0.pin-02-out => xstep').statements[0];
    expect(s.kind).toBe('linkps');
    expect(s.firstToken.text).toBe('parport.0.pin-02-out');
    expect(s.arrow).toBe('=>');
    expect(s.secondToken.text).toBe('xstep');
  });

  it('emits an error statement for an unknown command but keeps going', () => {
    const { statements } = parseHal('frobnicate x y\nnet good a.in b.out');
    expect(statements[0].kind).toBe('error');
    expect(statements[1].kind).toBe('net');
  });

  it('ignores comment-only and blank lines', () => {
    const { statements } = parseHal('# a comment\n\n   \nsetp x 1');
    expect(statements.length).toBe(1);
    expect(statements[0].kind).toBe('setp');
  });

  it('attaches an inline comment to its statement', () => {
    const s = parseHal('setp pid.0.Pgain 0.5  # the gain').statements[0];
    expect(s.comment?.text).toBe('# the gain');
  });
});
