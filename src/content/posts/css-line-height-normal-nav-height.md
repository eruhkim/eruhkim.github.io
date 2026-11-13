---
title: 같은 CSS인데 메뉴 높이가 6px 달랐다 – line-height는 부모에서 온다
description: 사이트 네 곳에 같은 상단 메뉴 CSS를 붙였는데 Tistory에서만 높이가 48px이었다. 메뉴는 line-height를 정하지 않아 각 사이트 body의 값을 물려받고 있었고, Tistory의 body는 line-height가 normal이었다.
pubDate: 2026-11-13
tags: [css, tistory]
---

내 사이트는 네 곳이다. 정적 HTML로 만든 이력서 사이트(한국어 소개 포함), Astro로 만든 이 블로그, 그리고 Tistory의 일상 블로그다. 모두 같은 상단 메뉴를 쓰도록 메뉴 CSS를 그대로 복사해 붙였다.

```css
.topnav {
  position: sticky;
  top: 0;
  display: flex;
  justify-content: center;
  border-bottom: 1px solid var(--line);
}

.topnav a {
  display: block;
  padding: 15px 14px;
  font-size: 14px;
  font-weight: 500;
}
```

그런데 페이지를 오가다 보면 Tistory에서만 메뉴가 살짝 낮았다. 재 보니 다른 세 곳은 54px, Tistory는 48px이었다.

## 높이는 어디서 오나

메뉴 높이는 링크 한 줄의 높이로 정해진다.

```text
메뉴 높이 = 위아래 padding(15 + 15) + 줄 높이 + border-bottom(1)
```

padding과 border는 같은 CSS이니 차이는 **줄 높이**에서 나온다. 그런데 위 CSS에는 `line-height`가 없다. 지정하지 않았으니 부모에서 물려받는다. 결국 각 사이트 `body`의 `line-height`가 메뉴 높이를 정하고 있었다.

| | body line-height | 14px 글자의 줄 높이 | 메뉴 높이 |
|---|---|---|---|
| 이력서, 이 블로그 | `1.65` | 14 × 1.65 = 23.1px | 30 + 23.1 + 1 ≈ 54px |
| Tistory | 지정 안 함 (`normal`) | 약 17px | 30 + 17 + 1 = 48px |

이력서 사이트와 이 블로그는 본문 가독성 때문에 `body`에 `line-height: 1.65`를 주고 있었다. Tistory 스킨은 `body`에 `line-height`를 주지 않았기 때문에 브라우저 기본값인 `normal`이 들어간다.

## normal은 숫자가 아니다

`line-height: normal`은 정해진 배수가 아니다. 브라우저가 **글꼴 파일에 들어 있는 값**(ascent, descent, line gap)으로 줄 높이를 계산한다. 그래서 글꼴마다 다르고, 같은 글꼴이라도 플랫폼에 따라 조금씩 다를 수 있다. 보통 1.0~1.3 사이 어딘가다. 여기서는 Pretendard 14px에서 약 17.3px, 1.24배 정도가 나왔다.

## 고친 방법

메뉴의 맨 바깥 요소에 `line-height`를 직접 박았다.

```css
.topnav {
  /* ... */
  line-height: 1.65; /* body 값에 기대지 않도록 */
}
```

이것만으로 Tistory의 메뉴도 54px이 됐다. 같은 이유로 제목 아래 부제(byline)도 Tistory에서만 높이가 27px로 다른 사이트(31px)보다 낮았는데, 이건 스킨을 고치면서 내가 `line-height: 1.4`를 줘서 생긴 차이였다. 같은 `1.65`로 맞췄다.

## 정리

- `line-height`는 상속된다. 정하지 않은 컴포넌트는 붙는 페이지의 `body` 값을 따라간다.
- 기본값 `normal`은 글꼴에 따라 달라지는 값이라, 같은 CSS여도 페이지마다 높이가 달라질 수 있다.
- 여러 사이트나 남의 페이지(블로그 스킨, 위젯 등)에 붙일 컴포넌트라면, 높이에 영향을 주는 `line-height`와 `font-family`, `font-size`는 컴포넌트 안에서 직접 정해 두는 게 안전하다.
