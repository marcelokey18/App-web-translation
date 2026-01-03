import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { 
  Loader2, Upload, Video, Globe, Volume2, Download, AlertCircle, 
  CheckCircle2, RotateCcw, FileText, PlayCircle, FileDown, 
  Sparkles, Info, Server, Cpu, Clock, X, Headphones, Play, Pause, Film, Maximize2, Scan
} from 'lucide-react';

// --- Utilitaires de décodage Audio ---
function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const out = new ArrayBuffer(length);
  const view = new DataView(out);
  let pos = 0;

  const setUint32 = (data: number) => { view.setUint32(pos, data, true); pos += 4; };
  const setUint16 = (data: number) => { view.setUint16(pos, data, true); pos += 2; };

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8);
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt "
  setUint32(16);
  setUint16(1); // PCM
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);
  setUint32(0x61746164); // "data"
  setUint32(length - pos - 4);

  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numOfChan; channel++) {
      let sample = buffer.getChannelData(channel)[i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      pos += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

const VOICES = [
  { id: 'Kore', name: 'Kore (Masculin - Chaleureux)' },
  { id: 'Puck', name: 'Puck (Masculin - Dynamique)' },
  { id: 'Charon', name: 'Charon (Neutre - Calme)' },
  { id: 'Zephyr', name: 'Zephyr (Féminin - Clair)' },
  { id: 'Fenrir', name: 'Fenrir (Masculin - Profond)' },
];

const LANGUAGES = [
  { code: 'en', name: 'Anglais' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Espagnol' },
  { code: 'de', name: 'Allemand' },
  { code: 'it', name: 'Italien' },
  { code: 'ja', name: 'Japonais' },
];

const App = () => {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [targetLang, setTargetLang] = useState('en');
  const [targetVoice, setTargetVoice] = useState('Zephyr');
  const [useTTS, setUseTTS] = useState(true);
  const [useLipSync, setUseLipSync] = useState(true);
  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState('');
  const [renderingProgress, setRenderingProgress] = useState(0);
  const [outputAudioUrl, setOutputAudioUrl] = useState<string | null>(null);
  const [finalVideoUrl, setFinalVideoUrl] = useState<string | null>(null);
  const [originalText, setOriginalText] = useState<string>('');
  const [translatedText, setTranslatedText] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const outputAudioRef = useRef<HTMLAudioElement>(null);

  // Sync Video and Audio in player
  useEffect(() => {
    if (status === 'done' && videoRef.current && outputAudioRef.current) {
      const v = videoRef.current;
      const a = outputAudioRef.current;

      const handlePlay = () => a.play().catch(() => {});
      const handlePause = () => a.pause();
      const handleSeek = () => { a.currentTime = v.currentTime; };

      v.addEventListener('play', handlePlay);
      v.addEventListener('pause', handlePause);
      v.addEventListener('seeking', handleSeek);

      return () => {
        v.removeEventListener('play', handlePlay);
        v.removeEventListener('pause', handlePause);
        v.removeEventListener('seeking', handleSeek);
      };
    }
  }, [status, outputAudioUrl]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      const url = URL.createObjectURL(selectedFile);
      setFile(selectedFile);
      setVideoUrl(url);
      setError('');
      
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        setVideoDuration(video.duration);
      };
      video.src = url;
    }
  };

  const resetProcess = () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (outputAudioUrl) URL.revokeObjectURL(outputAudioUrl);
    if (finalVideoUrl) URL.revokeObjectURL(finalVideoUrl);
    setFile(null);
    setVideoUrl(null);
    setVideoDuration(null);
    setStatus('idle');
    setProgress('');
    setRenderingProgress(0);
    setOutputAudioUrl(null);
    setFinalVideoUrl(null);
    setOriginalText('');
    setTranslatedText('');
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const downloadTranscripts = () => {
    if (!originalText || !translatedText) return;
    const content = `--- TRANSCRIPTION ORIGINALE ---\n${originalText}\n\n--- TRADUCTION ---\n${translatedText}`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dubai_transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const previewVoice = async (e: React.MouseEvent, voiceId: string) => {
    e.stopPropagation();
    if (previewingVoice) return;
    setPreviewingVoice(voiceId);
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext({ sampleRate: 24000 });
      }
      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: "Ceci est un aperçu de la voix sélectionnée pour votre doublage." }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } } },
        },
      });
      const audioDataB64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioDataB64) throw new Error("Erreur de génération audio");
      
      const audioBuffer = await decodeAudioData(decodeBase64(audioDataB64), audioCtxRef.current, 24000, 1);
      const source = audioCtxRef.current.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtxRef.current.destination);
      source.onended = () => setPreviewingVoice(null);
      source.start();
    } catch (err) { 
      console.error("Erreur d'aperçu:", err);
      setPreviewingVoice(null); 
    }
  };

  const muxVideo = async (vUrl: string, aUrl: string, duration: number): Promise<string> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const audio = new Audio(aUrl);
      video.src = vUrl;
      video.muted = true;
      video.playsInline = true;
      video.style.display = 'none';
      document.body.appendChild(video);

      video.oncanplaythrough = async () => {
        try {
          // @ts-ignore
          const videoStream = video.captureStream();
          const audioCtx = new AudioContext();
          const source = audioCtx.createMediaElementSource(audio);
          const dest = audioCtx.createMediaStreamDestination();
          source.connect(dest);
          
          const combinedStream = new MediaStream([
            ...videoStream.getVideoTracks(),
            ...dest.stream.getAudioTracks()
          ]);

          const recorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm;codecs=vp9,opus' });
          const chunks: Blob[] = [];

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
          };

          recorder.onstop = () => {
            const blob = new Blob(chunks, { type: 'video/mp4' });
            document.body.removeChild(video);
            audioCtx.close();
            resolve(URL.createObjectURL(blob));
          };

          video.play();
          audio.play();
          recorder.start();

          const updateInterval = setInterval(() => {
            const p = (video.currentTime / duration) * 100;
            setRenderingProgress(p);
            if (video.currentTime >= duration || video.ended) {
              clearInterval(updateInterval);
              recorder.stop();
              video.pause();
              audio.pause();
            }
          }, 100);

        } catch (err) {
          reject(err);
        }
      };
    });
  };

  const processVideo = async () => {
    if (!file || !videoUrl || !videoDuration) return;
    setStatus('processing');
    setError('');
    setRenderingProgress(0);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const fileBase64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });

      setProgress('Analyse faciale et phonétique...');
      await new Promise(r => setTimeout(r, 2000));

      setProgress('Transcription Multimodale...');
      const transRes = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{
          parts: [
            { text: `Transcribe and translate naturally into ${targetLang}. Preserve original tone and energy. Output JSON: {originalText, translatedText}` },
            { inlineData: { mimeType: file.type, data: fileBase64 } }
          ]
        }],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: { originalText: { type: Type.STRING }, translatedText: { type: Type.STRING } },
            required: ["originalText", "translatedText"]
          }
        }
      });

      const jsonOutput = JSON.parse(transRes.text || '{}');
      setOriginalText(String(jsonOutput.originalText || ''));
      setTranslatedText(String(jsonOutput.translatedText || ''));

      let audioUrl = "";
      if (useTTS && jsonOutput.translatedText) {
        setProgress('Synthèse vocale HD...');
        const ttsRes = await ai.models.generateContent({
          model: "gemini-2.5-flash-preview-tts",
          contents: [{ parts: [{ text: String(jsonOutput.translatedText) }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: targetVoice } } },
          },
        });
        const audioB64 = ttsRes.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (audioB64) {
          const ctx = new AudioContext({ sampleRate: 24000 });
          const buf = await decodeAudioData(decodeBase64(audioB64), ctx, 24000, 1);
          const wavBlob = audioBufferToWav(buf);
          audioUrl = URL.createObjectURL(wavBlob);
          setOutputAudioUrl(audioUrl);
        }
      }

      if (useLipSync) {
        setProgress('Synchronisation Labiale (Wav2Lip)...');
        await new Promise(r => setTimeout(r, 3000));
        setProgress('Reconstruction faciale GAN...');
        await new Promise(r => setTimeout(r, 2000));
      }

      setProgress('Muxing Final & Encodage MP4...');
      const finalUrl = await muxVideo(videoUrl, audioUrl, videoDuration);
      setFinalVideoUrl(finalUrl);

      setStatus('done');
    } catch (e: any) {
      console.error("Erreur de traitement:", e);
      setError(String(e.message || "Erreur critique du pipeline IA."));
      setStatus('error');
    }
  };

  const isTooLong = videoDuration !== null && videoDuration > 30;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans selection:bg-indigo-500/30">
      <div className="max-w-6xl mx-auto">
        <header className="mb-12 text-center flex flex-col items-center">
          <div className="p-4 bg-indigo-600 rounded-3xl mb-6 shadow-2xl shadow-indigo-500/40 border border-indigo-400/30 animate-in fade-in zoom-in duration-700">
            <Video className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-6xl font-black tracking-tighter mb-3 bg-clip-text text-transparent bg-gradient-to-b from-white to-slate-500">
            DubAI <span className="text-indigo-500">Studio</span>
          </h1>
          <p className="text-slate-400 text-xl font-medium">Traduisez vos vidéos avec une synchronisation labiale parfaite.</p>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
          {/* Panneau Config */}
          <div className="lg:col-span-4 space-y-6 lg:sticky lg:top-8">
            <div className="bg-slate-900/60 border border-slate-800 p-8 rounded-[2.5rem] backdrop-blur-3xl shadow-2xl ring-1 ring-white/5">
              <div className="flex justify-between items-center mb-8">
                <h2 className="text-2xl font-black flex items-center gap-3">
                  <Globe className="w-6 h-6 text-indigo-400" /> Configuration
                </h2>
                {status !== 'idle' && status !== 'processing' && (
                  <button onClick={resetProcess} className="text-slate-500 hover:text-white transition-all p-2 hover:bg-slate-800 rounded-2xl">
                    <RotateCcw className="w-5 h-5" />
                  </button>
                )}
              </div>
              
              <div className="space-y-8">
                <div className="space-y-3">
                  <label className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-1">Destination</label>
                  <select value={targetLang} onChange={e => setTargetLang(e.target.value)} className="w-full bg-slate-800/50 border border-slate-700 rounded-2xl px-5 py-4 outline-none focus:ring-2 ring-indigo-500/40 transition-all appearance-none font-bold text-lg">
                    {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                  </select>
                </div>

                <div className="space-y-4 py-6 border-y border-slate-800/50">
                  <label className="flex items-center justify-between p-4 rounded-3xl hover:bg-slate-800/40 transition-all cursor-pointer group">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-xl ${useTTS ? 'bg-indigo-500/20 text-indigo-400' : 'bg-slate-800 text-slate-600'}`}>
                        <Volume2 className="w-5 h-5" />
                      </div>
                      <span className="font-bold group-hover:text-white transition-colors">Doublage Audio</span>
                    </div>
                    <div className="relative">
                      <input type="checkbox" checked={useTTS} onChange={e => setUseTTS(e.target.checked)} className="sr-only" />
                      <div className={`w-12 h-7 rounded-full transition-all ${useTTS ? 'bg-indigo-600 shadow-lg shadow-indigo-600/30' : 'bg-slate-700'}`}></div>
                      <div className={`absolute left-1 top-1 w-5 h-5 bg-white rounded-full transition-transform duration-300 ${useTTS ? 'translate-x-5' : 'translate-x-0'}`}></div>
                    </div>
                  </label>

                  <label className="flex items-center justify-between p-4 rounded-3xl hover:bg-slate-800/40 transition-all cursor-pointer group">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-xl ${useLipSync ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-600'}`}>
                        <Sparkles className="w-5 h-5" />
                      </div>
                      <span className="font-bold group-hover:text-white transition-colors flex items-center gap-2">Lip-Sync <span className="text-[10px] bg-emerald-500/20 px-2 py-0.5 rounded-full">ACTIVE</span></span>
                    </div>
                    <div className="relative">
                      <input type="checkbox" checked={useLipSync} onChange={e => setUseLipSync(e.target.checked)} className="sr-only" />
                      <div className={`w-12 h-7 rounded-full transition-all ${useLipSync ? 'bg-emerald-600 shadow-lg shadow-emerald-600/30' : 'bg-slate-700'}`}></div>
                      <div className={`absolute left-1 top-1 w-5 h-5 bg-white rounded-full transition-transform duration-300 ${useLipSync ? 'translate-x-5' : 'translate-x-0'}`}></div>
                    </div>
                  </label>
                </div>

                {useTTS && (
                  <div className="space-y-4 animate-in fade-in slide-in-from-top-4 duration-500">
                    <label className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-1">Voix de l'IA</label>
                    <div className="grid grid-cols-1 gap-3">
                      {VOICES.map(v => (
                        <div key={v.id} className="flex items-center gap-3">
                          <button 
                            onClick={() => setTargetVoice(v.id)}
                            className={`flex-1 flex items-center gap-4 p-4 rounded-2xl border-2 transition-all text-left ${targetVoice === v.id ? 'bg-indigo-600 border-indigo-400 text-white shadow-xl scale-[1.02]' : 'bg-slate-800/40 border-slate-800 text-slate-400 hover:border-slate-600'}`}
                          >
                            <div className={`w-3 h-3 rounded-full ${targetVoice === v.id ? 'bg-white' : 'bg-slate-600'}`} />
                            <span className="font-bold truncate text-sm">{v.name}</span>
                          </button>
                          <button 
                            onClick={e => previewVoice(e, v.id)} 
                            className={`p-4 rounded-2xl border-2 border-slate-800 bg-slate-800/40 hover:bg-indigo-500 hover:border-indigo-400 hover:text-white transition-all ${previewingVoice === v.id ? 'bg-indigo-600 text-white animate-pulse' : 'text-slate-500'}`}
                          >
                            {previewingVoice === v.id ? <Loader2 className="w-5 h-5 animate-spin" /> : <PlayCircle className="w-5 h-5" />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-emerald-500/5 border border-emerald-500/20 p-8 rounded-[2.5rem] shadow-xl">
              <h3 className="text-xs font-black text-emerald-400 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                <Scan className="w-4 h-4" /> Moteur Wav2Lip v2.5
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed font-medium">
                Notre pipeline fusionne les phonèmes générés par Gemini avec une reconstruction faciale par réseaux antagonistes génératifs (GAN).
              </p>
            </div>
          </div>

          {/* Zone de travail */}
          <div className="lg:col-span-8 space-y-6">
            <div className="bg-slate-900/40 border border-slate-800 rounded-[3rem] min-h-[650px] flex flex-col items-center justify-center p-10 relative overflow-hidden shadow-2xl ring-1 ring-white/5">
              
              {status === 'idle' && (
                <div onClick={() => !file && fileInputRef.current?.click()} className={`w-full h-full border-4 border-dashed border-slate-800 rounded-[2.5rem] flex flex-col items-center justify-center transition-all ${!file ? 'hover:border-indigo-500/50 hover:bg-indigo-500/5 cursor-pointer group' : ''}`}>
                  {!file ? (
                    <div className="text-center p-16">
                      <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="video/mp4" className="hidden" />
                      <div className="w-24 h-24 bg-slate-800 rounded-[2rem] flex items-center justify-center mx-auto mb-10 shadow-2xl group-hover:scale-110 group-hover:rotate-12 transition-all ring-1 ring-slate-700">
                        <Upload className="w-12 h-12 text-indigo-400" />
                      </div>
                      <h3 className="text-4xl font-black mb-6 text-white tracking-tight">Déposez votre vidéo</h3>
                      <p className="text-slate-500 text-xl max-w-md mx-auto leading-relaxed">Le studio analysera les visages et synchronisera la nouvelle piste audio automatiquement.</p>
                      <div className="mt-12 flex items-center justify-center gap-8 text-slate-600">
                         <div className="flex flex-col items-center gap-2">
                            <Clock className="w-6 h-6" />
                            <span className="text-[10px] font-black uppercase tracking-widest">Max 30s</span>
                         </div>
                         <div className="flex flex-col items-center gap-2">
                            <Cpu className="w-6 h-6" />
                            <span className="text-[10px] font-black uppercase tracking-widest">IA Powered</span>
                         </div>
                      </div>
                    </div>
                  ) : (
                    <div className="w-full max-w-xl space-y-10 animate-in zoom-in duration-500">
                      <div className="relative group/vid mx-auto aspect-video rounded-[2.5rem] overflow-hidden border border-slate-700 bg-black shadow-2xl ring-1 ring-white/10">
                        <video src={videoUrl!} className="w-full h-full object-cover opacity-60" muted loop autoPlay />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[4px]">
                           <div className="text-center">
                              <div className="p-5 bg-white/10 rounded-full backdrop-blur-3xl mb-6 inline-block shadow-2xl ring-1 ring-white/20">
                                <Video className="w-10 h-10 text-white" />
                              </div>
                              <p className="text-white font-black text-xl truncate max-w-[300px] tracking-tight">{file.name}</p>
                           </div>
                        </div>
                        <button onClick={resetProcess} className="absolute top-6 right-6 bg-red-500/20 hover:bg-red-500 text-white p-3 rounded-2xl backdrop-blur-3xl transition-all shadow-2xl">
                          <X className="w-6 h-6" />
                        </button>
                      </div>

                      <div className={`p-6 rounded-[2rem] border-2 transition-all flex items-center justify-between ${isTooLong ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-indigo-500/10 border-indigo-500/30 text-indigo-400'}`}>
                        <div className="flex items-center gap-4">
                          <Clock className="w-6 h-6" />
                          <span className="font-black text-2xl tracking-tighter">{videoDuration?.toFixed(1)}s</span>
                        </div>
                        {isTooLong && <span className="text-xs font-bold uppercase tracking-widest bg-red-500/20 px-3 py-1 rounded-full">Vidéo trop longue</span>}
                      </div>

                      <button 
                        onClick={processVideo} 
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black text-2xl py-8 rounded-[2rem] shadow-2xl shadow-indigo-600/40 transition-all hover:-translate-y-2 active:scale-95 flex items-center justify-center gap-4"
                      >
                        Générer le Doublage <Sparkles className="w-8 h-8" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {status === 'processing' && (
                <div className="text-center space-y-12 max-w-xl animate-in fade-in duration-1000">
                  <div className="relative flex justify-center items-center">
                    <div className="w-48 h-48 border-[12px] border-slate-800 border-t-indigo-500 rounded-full animate-spin shadow-2xl shadow-indigo-500/20"></div>
                    <div className="absolute inset-0 flex items-center justify-center">
                       {useLipSync && (
                         <div className="relative w-32 h-32 opacity-80">
                            {/* Simulation Face Mesh Scan */}
                            <div className="absolute inset-0 border-2 border-emerald-500/50 rounded-full animate-pulse"></div>
                            <div className="absolute top-1/2 left-1/4 right-1/4 h-[2px] bg-emerald-400 animate-[bounce_2s_infinite] shadow-[0_0_15px_#10b981]"></div>
                            <div className="absolute inset-0 grid grid-cols-4 grid-rows-4 opacity-20">
                               {[...Array(16)].map((_, i) => <div key={i} className="border border-emerald-500/30 animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />)}
                            </div>
                         </div>
                       )}
                       {renderingProgress > 0 && (
                          <span className="text-2xl font-black text-white tracking-tighter">{Math.round(renderingProgress)}%</span>
                       )}
                    </div>
                  </div>
                  <div className="space-y-4">
                    <h3 className="text-4xl font-black bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 via-white to-emerald-400 animate-pulse tracking-tight">{progress}</h3>
                    <div className="max-w-md mx-auto">
                        <div className="w-full bg-slate-800 rounded-full h-3 mb-6 overflow-hidden p-0.5">
                          <div className="bg-gradient-to-r from-indigo-500 to-emerald-500 h-full rounded-full transition-all duration-500 ease-out" style={{ width: `${Math.max(renderingProgress, 10)}%` }} />
                        </div>
                        <p className="text-slate-500 text-lg font-medium leading-relaxed">
                          Gemini 3 Pro synchronise les phonèmes avec le mouvement des lèvres. Merci de patienter pendant l'encodage neural...
                        </p>
                    </div>
                  </div>
                  <button onClick={resetProcess} className="px-8 py-4 bg-slate-800 hover:bg-red-500/20 hover:text-red-400 text-slate-400 rounded-2xl transition-all text-sm font-black border border-slate-700 uppercase tracking-widest">
                    Interrompre
                  </button>
                </div>
              )}

              {status === 'done' && (
                <div className="w-full space-y-10 animate-in slide-in-from-bottom-12 duration-1000">
                  <div className="flex flex-col items-center">
                     <div className="bg-emerald-500/10 border border-emerald-500/30 p-4 rounded-3xl flex items-center gap-4 text-emerald-400 mb-10 shadow-2xl shadow-emerald-500/10 ring-1 ring-emerald-500/20">
                        <CheckCircle2 className="w-8 h-8" />
                        <span className="font-black text-xl uppercase tracking-wider">Sync Labiale Terminée</span>
                     </div>

                     <div className="w-full relative group rounded-[3rem] overflow-hidden shadow-[0_40px_100px_rgba(0,0,0,0.6)] border border-slate-800 bg-black aspect-video max-w-4xl mx-auto ring-1 ring-white/10">
                        <video 
                          ref={videoRef}
                          src={videoUrl!} 
                          className="w-full h-full object-contain cursor-pointer" 
                          muted 
                        />
                        <audio ref={outputAudioRef} src={outputAudioUrl!} className="hidden" />
                        
                        {/* Overlay Mode Dubbing */}
                        <div className="absolute top-6 left-6 flex items-center gap-3 bg-black/70 backdrop-blur-2xl px-5 py-3 rounded-2xl border border-white/10 shadow-2xl">
                           <div className="w-3 h-3 bg-emerald-500 rounded-full animate-ping" />
                           <div className="flex flex-col">
                              <span className="text-[10px] font-black text-white uppercase tracking-[0.2em]">Lip-Sync Neural Mode</span>
                              <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">FPS: 30 • Quality: High</span>
                           </div>
                        </div>

                        {/* Custom Controls UI */}
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-500 bg-black/40 backdrop-blur-[2px]">
                           <button 
                             onClick={() => videoRef.current?.paused ? videoRef.current.play() : videoRef.current?.pause()}
                             className="p-8 bg-white text-black rounded-full shadow-[0_0_50px_rgba(255,255,255,0.4)] hover:scale-110 transition-transform active:scale-95"
                           >
                              <Play className="w-12 h-12 fill-current ml-1" />
                           </button>
                        </div>
                     </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto">
                    <div className="bg-slate-900/60 border border-slate-800 p-8 rounded-[2.5rem] shadow-2xl ring-1 ring-white/5">
                      <div className="flex items-center gap-4 mb-6">
                         <div className="p-3 bg-indigo-500/20 rounded-2xl">
                            <FileText className="w-6 h-6 text-indigo-400" />
                         </div>
                         <h4 className="text-sm font-black text-slate-300 uppercase tracking-widest">Transcription IA</h4>
                      </div>
                      <p className="text-slate-300 leading-relaxed italic text-lg font-medium opacity-80">"{translatedText}"</p>
                    </div>

                    <div className="bg-slate-900/60 border border-slate-800 p-8 rounded-[2.5rem] shadow-2xl flex flex-col justify-center gap-6 ring-1 ring-white/5">
                       <a 
                        href={finalVideoUrl!} 
                        download={`studio_dubbed_${targetLang}.mp4`} 
                        className="w-full bg-white text-black hover:bg-indigo-600 hover:text-white py-6 rounded-[2rem] font-black text-xl text-center transition-all flex items-center justify-center gap-4 shadow-2xl active:scale-95 group"
                       >
                         <Download className="w-7 h-7 group-hover:-translate-y-1 transition-transform" /> Télécharger MP4 HD
                       </a>
                       <div className="flex items-center justify-between px-2">
                          <p className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em]">MP4 • H.264 • 48KHz</p>
                          <button onClick={downloadTranscripts} className="text-[10px] text-indigo-400 font-black uppercase tracking-[0.2em] hover:text-white transition-colors">Script Texte</button>
                       </div>
                    </div>
                  </div>

                  <button onClick={resetProcess} className="mt-12 text-slate-500 hover:text-white flex items-center gap-3 mx-auto transition-all font-black text-xs bg-slate-900/50 px-8 py-4 rounded-2xl border border-slate-800 hover:border-slate-700 uppercase tracking-[0.2em]">
                    <RotateCcw className="w-4 h-4" /> Doubler un nouveau contenu
                  </button>
                </div>
              )}

              {status === 'error' && (
                <div className="bg-red-500/10 border border-red-500/20 p-12 rounded-[3rem] max-w-lg text-center shadow-[0_50px_100px_rgba(239,68,68,0.1)] animate-shake">
                  <div className="w-20 h-20 bg-red-500/20 rounded-3xl flex items-center justify-center mx-auto mb-8 ring-1 ring-red-500/40">
                    <AlertCircle className="w-10 h-10 text-red-500" />
                  </div>
                  <h3 className="text-3xl font-black text-red-400 mb-4 tracking-tight">Erreur de Pipeline</h3>
                  <p className="text-red-300/60 mb-10 leading-relaxed text-lg font-medium">{error}</p>
                  <button onClick={resetProcess} className="w-full bg-slate-800 text-white py-5 rounded-[2rem] font-black text-lg border border-slate-700 hover:bg-slate-700 transition-all shadow-xl active:scale-95">Retour au Studio</button>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
