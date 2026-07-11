import { Assets, type Texture } from 'pixi.js';

export interface Textures {
  ground: Texture;
  block: Texture;
  /** 4-frame ant walk cycle. */
  antWalk: Texture[];
  food: Texture;
  cave: Texture;
  grass: Texture;
  portalBlue: Texture[];
  portalOrange: Texture[];
  queen: Texture;
  egg: Texture;
  larva: Texture;
  pupa: Texture;
}

export async function loadTextures(baseUrl = 'images'): Promise<Textures> {
  const path = (name: string) => `${baseUrl}/${name}`;

  const [
    ground, block, antWalk0, antWalk1, antWalk3, food, cave, grass, pb0, pb1, pb2, po0, po1, po2,
    queen, egg, larva, pupa,
  ] = await Promise.all([
      Assets.load<Texture>(path('ground01.png')),
      Assets.load<Texture>(path('block01.png')),
      Assets.load<Texture>(path('antWalk_01.png')),
      Assets.load<Texture>(path('antWalk_02.png')),
      Assets.load<Texture>(path('antWalk_03.png')),
      Assets.load<Texture>(path('food04.png')),
      Assets.load<Texture>(path('cave.png')),
      Assets.load<Texture>(path('grass01.png')),
      Assets.load<Texture>(path('portalBlue_00.png')),
      Assets.load<Texture>(path('portalBlue_01.png')),
      Assets.load<Texture>(path('portalBlue_02.png')),
      Assets.load<Texture>(path('portalOrange_00.png')),
      Assets.load<Texture>(path('portalOrange_01.png')),
      Assets.load<Texture>(path('portalOrange_02.png')),
      Assets.load<Texture>(path('queen.png')),
      Assets.load<Texture>(path('egg.png')),
      Assets.load<Texture>(path('larva.png')),
      Assets.load<Texture>(path('pupa.png')),
    ]);

  return {
    ground,
    block,
    // frame 2 of the walk cycle reuses frame 1's art, matching the original sprite set
    antWalk: [antWalk0, antWalk1, antWalk1, antWalk3],
    food,
    cave,
    grass,
    portalBlue: [pb0, pb1, pb2],
    portalOrange: [po0, po1, po2],
    queen,
    egg,
    larva,
    pupa,
  };
}
