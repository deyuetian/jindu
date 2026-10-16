import {useEffect,useId,useRef,useState,type InputHTMLAttributes,type ChangeEvent} from 'react';
import {CalendarDays} from 'lucide-react';
import {dateSchema} from '../shared/model';

type Props=InputHTMLAttributes<HTMLInputElement>;
/** Keep the visible format stable while retaining the device's date picker. */
export default function DateInput({type='date',value,defaultValue,onChange,onInput,onBlur,...props}:Props){
  const [draft,setDraft]=useState(String(value??defaultValue??''));
  const [revealed,setRevealed]=useState(false),errorId=useId();
  const picker=useRef<HTMLInputElement>(null),input=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(value!==undefined)setDraft(String(value??''));},[value]);
  useEffect(()=>{if(type==='date')input.current?.setCustomValidity(error(draft));},[draft,type,props.min,props.max]);
  if(type!=='date')return <input {...props} type={type} value={value} defaultValue={defaultValue} onChange={onChange} onInput={onInput} onBlur={onBlur}/>;
  function valid(text:string){return !text||dateSchema.safeParse(text).success;}
  function error(text:string){
    if(!valid(text))return '请输入有效日期，格式为 YYYY-MM-DD';
    if(text&&((props.min&&text<String(props.min))||(props.max&&text>String(props.max))))return '日期不在允许范围内';
    return '';
  }
  function change(event:ChangeEvent<HTMLInputElement>){
    const raw=event.currentTarget.value;
    const normalized=raw.replace(/^(\d{4})[/.年](\d{1,2})[/.月](\d{1,2})日?$/,(_m,y,m,d)=>`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
    const message=error(normalized);setDraft(valid(normalized)?normalized:raw);setRevealed(normalized.length>=10);
    input.current?.setCustomValidity(message);
    if(message)return;
    event.currentTarget.value=normalized;
    onChange?.(event);
  }
  const message=error(draft),visibleError=!!message&&(revealed||valid(draft));
  return <span className="date-input"><input {...props} ref={input} type="text" value={draft} placeholder="YYYY-MM-DD" inputMode="numeric" autoComplete="off" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" aria-invalid={message?'true':props['aria-invalid']} aria-describedby={[props['aria-describedby'],visibleError?errorId:''].filter(Boolean).join(' ')||undefined} onChange={change} onInvalid={event=>{setRevealed(true);props.onInvalid?.(event);}} onBlur={event=>{setRevealed(true);event.currentTarget.setCustomValidity(error(draft));onBlur?.(event);}}/>
    <button type="button" className="date-picker-button" aria-label="选择日期" disabled={props.disabled||props.readOnly} onClick={event=>{event.preventDefault();try{picker.current?.showPicker();}catch{picker.current?.click();}}}><CalendarDays size={17}/></button>
    <input ref={picker} type="date" aria-hidden="true" tabIndex={-1} className="native-date-picker" min={props.min} max={props.max} value={valid(draft)?draft:''} disabled={props.disabled||props.readOnly} onChange={change}/>
    {visibleError&&<small id={errorId} className="date-input-error" role="alert">{message}</small>}
  </span>;
}
